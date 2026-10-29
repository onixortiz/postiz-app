import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WorkflowRole } from '@prisma/client';
import dayjs from 'dayjs';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { ApprovalsRepository } from '@gitroom/nestjs-libraries/database/prisma/approvals/approvals.repository';

// FORK: approvals

export type ApprovalTemplate =
  | 'SUBMITTED'
  | 'REVIEW_APPROVED'
  | 'REJECTED'
  | 'RESET_BY_EDIT'
  | 'WARN_48H'
  | 'WARN_24H'
  | 'EXPIRED'
  | 'PUBLISHED'
  | 'VERIFY_OVERDUE'
  | 'FORCED'
  | 'BLOCKED_AT_PUBLISH'
  | 'RECONCILED'
  | 'VERIFICATION_PROBLEM';

export interface ApprovalNotifyData {
  approvalId: string;
  batchId: string;
}

// the texts never carry the post content or a comment, only the topic and the url
const TEMPLATES: Record<ApprovalTemplate, { subject: string; text: string }> = {
  SUBMITTED: {
    subject: 'Post para revisar: {topic}',
    text: 'Un post está esperando revisión.',
  },
  REVIEW_APPROVED: {
    subject: 'Post para aprobación final: {topic}',
    text: 'Un post pasó la revisión y espera la aprobación final.',
  },
  REJECTED: {
    subject: 'Cambios pedidos: {topic}',
    text: 'Se pidieron cambios en un post que enviaste.',
  },
  RESET_BY_EDIT: {
    subject: 'Post editado, vuelve a revisión: {topic}',
    text: 'Un post se editó después de enviarse y vuelve a revisión.',
  },
  WARN_48H: {
    subject: 'Vence en 48 h: {topic}',
    text: 'Un post sin aprobación final se publica en menos de 48 horas.',
  },
  WARN_24H: {
    subject: 'Vence en 24 h: {topic}',
    text: 'Un post sin aprobación final se publica en menos de 24 horas.',
  },
  EXPIRED: {
    subject: 'Venció sin aprobación: {topic}',
    text: 'Llegó la fecha de publicación de un post sin aprobación final. No se publicó.',
  },
  PUBLISHED: {
    subject: 'Publicado, falta verificar: {topic}',
    text: 'Un post se publicó en todos sus canales. Falta verificar que se ve bien.',
  },
  VERIFY_OVERDUE: {
    subject: 'Verificación pendiente: {topic}',
    text: 'Un post publicado lleva más de 24 horas sin verificar.',
  },
  FORCED: {
    subject: 'Publicación forzada: {topic}',
    text: 'Un post se aprobó sin pasar por toda la cadena de aprobación.',
  },
  BLOCKED_AT_PUBLISH: {
    subject: 'Se impidió publicar sin aprobación: {topic}',
    text: 'Un post intentó publicarse sin aprobación válida y se detuvo.',
  },
  RECONCILED: {
    subject: 'Post sin aprobación desprogramado: {topic}',
    text: 'Un post programado sin aprobación válida volvió a borrador.',
  },
  VERIFICATION_PROBLEM: {
    subject: 'Problema en un post publicado: {topic}',
    text: 'Se marcó un problema en un post publicado.',
  },
};

const RESET_NOTICE_WINDOW_MINUTES = 15;

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

@Injectable()
export class ApprovalNotifyService implements OnModuleInit {
  private readonly _logger = new Logger(ApprovalNotifyService.name);

  constructor(
    private _notificationService: NotificationService,
    private _approvalsRepository: ApprovalsRepository
  ) {}

  onModuleInit() {
    if (
      process.env.APPROVALS_ENABLED === 'true' &&
      !this._notificationService.hasEmailProvider()
    ) {
      this._logger.warn(
        'APPROVALS_ENABLED is on but there is no email provider: approval notices are only shown in the app'
      );
    }
  }

  // a failed notice is logged and never breaks the action that sent it
  async notifyRole(
    orgId: string,
    role: WorkflowRole,
    template: ApprovalTemplate,
    data: ApprovalNotifyData
  ) {
    try {
      if (
        template === 'RESET_BY_EDIT' &&
        (await this.resetNoticedRecently(orgId, data.approvalId))
      ) {
        return;
      }

      const message = await this.render(orgId, template, data);
      await this._notificationService.inAppNotification(
        orgId,
        message.subject,
        message.text,
        false
      );

      const users = await this._approvalsRepository.listUsersWithRole(
        orgId,
        role
      );
      for (const user of users) {
        await this._notificationService.sendEmail(
          user.email,
          message.subject,
          message.html
        );
      }
    } catch (err) {
      this._logger.error(
        `notifyRole ${template} failed for approval ${data.approvalId}`,
        err
      );
    }
  }

  async notifyUser(
    orgId: string,
    userId: string,
    template: ApprovalTemplate,
    data: ApprovalNotifyData
  ) {
    try {
      const message = await this.render(orgId, template, data);
      await this._notificationService.inAppNotification(
        orgId,
        message.subject,
        message.text,
        false
      );

      const email = await this._approvalsRepository.getMemberEmail(
        orgId,
        userId
      );
      if (email) {
        await this._notificationService.sendEmail(
          email,
          message.subject,
          message.html
        );
      }
    } catch (err) {
      this._logger.error(
        `notifyUser ${template} failed for approval ${data.approvalId}`,
        err
      );
    }
  }

  // 'info' is the only type that is emailed regardless of the user preferences
  async notifyTeam(
    orgId: string,
    template: ApprovalTemplate,
    data: ApprovalNotifyData
  ) {
    try {
      const message = await this.render(orgId, template, data);
      await this._notificationService.inAppNotification(
        orgId,
        message.subject,
        message.text,
        true,
        false,
        'info'
      );
    } catch (err) {
      this._logger.error(
        `notifyTeam ${template} failed for approval ${data.approvalId}`,
        err
      );
    }
  }

  async notifyAdmins(
    orgId: string,
    template: ApprovalTemplate,
    data: ApprovalNotifyData
  ) {
    try {
      const message = await this.render(orgId, template, data);
      const admins = await this._approvalsRepository.listOrgAdmins(orgId);
      for (const admin of admins) {
        await this._notificationService.sendEmail(
          admin.email,
          message.subject,
          message.html
        );
      }
    } catch (err) {
      this._logger.error(
        `notifyAdmins ${template} failed for approval ${data.approvalId}`,
        err
      );
    }
  }

  // the RESET_BY_EDIT that triggered this notice is already stored, so the
  // window is measured against the one before it
  private async resetNoticedRecently(orgId: string, approvalId: string) {
    const latest = await this._approvalsRepository.lastActorOf(
      orgId,
      approvalId,
      'RESET_BY_EDIT'
    );
    if (!latest) {
      return false;
    }

    const previous = await this._approvalsRepository.previousEventOf(
      orgId,
      approvalId,
      'RESET_BY_EDIT',
      latest.createdAt
    );

    return (
      !!previous &&
      dayjs().diff(dayjs(previous.createdAt), 'minute', true) <
        RESET_NOTICE_WINDOW_MINUTES
    );
  }

  private async render(
    orgId: string,
    template: ApprovalTemplate,
    data: ApprovalNotifyData
  ) {
    const [approval, root] = await Promise.all([
      this._approvalsRepository.getApprovalByBatch(orgId, data.batchId),
      this._approvalsRepository.getFirstRootPostId(orgId, data.batchId),
    ]);

    const topic = approval?.brief?.topic || '(sin tema)';
    const url = root ? `${process.env.FRONTEND_URL}/p/${root.id}` : '';
    const { subject, text } = TEMPLATES[template];

    return {
      subject: subject.replace('{topic}', topic),
      text: [text, url].filter((f) => f).join('\n'),
      html: `<p>${escapeHtml(text)}</p>${
        url ? `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` : ''
      }`,
    };
  }
}
