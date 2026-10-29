'use client';

import { FC, useCallback, useState } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import {
  useApprovalActions,
  useWorkflowRoles,
  WorkflowRole,
} from '@gitroom/frontend/components/approvals/use.approvals';
import { useRoleName } from '@gitroom/frontend/components/approvals/approval.history.component';

// FORK: approvals. One row per member with a box per workflow role. Only an
// admin changes them.
const ROLES: WorkflowRole[] = [
  'TECHNICAL_WRITER',
  'CREATOR',
  'REVIEWER',
  'MONTHLY_REVIEWER',
];

export const WorkflowRolesComponent: FC = () => {
  const t = useT();
  const toaster = useToaster();
  const user = useUser();
  const roleName = useRoleName();
  const actions = useApprovalActions();
  const { data: members } = useWorkflowRoles();
  const [saving, setSaving] = useState<string | null>(null);
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPERADMIN';

  const toggle = useCallback(
    async (userId: string, current: WorkflowRole[], role: WorkflowRole) => {
      setSaving(userId);
      const result = await actions.setRoles(
        userId,
        current.includes(role)
          ? current.filter((p) => p !== role)
          : [...current, role]
      );
      setSaving(null);
      if (!result.ok) {
        toaster.show(
          result.message ||
            t('approvals_action_failed', 'The action could not be completed'),
          'warning'
        );
      }
    },
    [actions, toaster, t]
  );

  const count = (role: WorkflowRole) =>
    (members || []).filter((p) => p.roles.includes(role)).length;

  return (
    <div className="flex flex-col mt-[24px]">
      <h3 className="text-[20px]">
        {t('approvals_workflow_roles', 'Workflow roles')}
      </h3>
      <div className="text-textItemBlur mt-[4px]">
        {t(
          'approvals_workflow_roles_description',
          'Who writes the topics, creates the posts, reviews them and gives the final approval.'
        )}
      </div>
      {(count('REVIEWER') < 2 || count('MONTHLY_REVIEWER') < 2) && (
        <div className="mt-[12px] rounded-[8px] border border-approvalFinal text-approvalFinal px-[12px] py-[8px] text-[13px]">
          {t(
            'approvals_staffing_warning',
            'Assign at least 2 Reviewers and 2 Monthly Reviewers: nobody can approve their own posts, and posts wait when the only reviewer is away.'
          )}
        </div>
      )}
      <div className="my-[16px] border border-newTableBorder rounded-[8px] overflow-x-auto">
        <table className="w-full text-[14px]">
          <thead>
            <tr className="bg-newTableHeader text-newTableText">
              <th className="text-start px-[16px] py-[10px] font-[500]">
                {t('approvals_member', 'Member')}
              </th>
              {ROLES.map((role) => (
                <th
                  key={role}
                  className="px-[12px] py-[10px] font-[500] whitespace-nowrap"
                >
                  {roleName(role)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(members || []).map((member) => (
              <tr
                key={member.userId}
                className="border-t border-newTableBorder"
              >
                <td className="px-[16px] py-[10px]">
                  <div>{member.name}</div>
                  {/* the name falls back to the email */}
                  {member.name !== member.email && (
                    <div className="text-[12px] text-textItemBlur">
                      {member.email}
                    </div>
                  )}
                </td>
                {ROLES.map((role) => (
                  <td key={role} className="text-center px-[12px] py-[10px]">
                    <input
                      type="checkbox"
                      className="w-[16px] h-[16px] cursor-pointer disabled:cursor-not-allowed"
                      aria-label={`${member.name} ${roleName(role)}`}
                      disabled={!isAdmin || saving === member.userId}
                      checked={member.roles.includes(role)}
                      onChange={() => toggle(member.userId, member.roles, role)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
