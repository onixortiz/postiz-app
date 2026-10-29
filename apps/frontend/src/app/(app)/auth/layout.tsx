import { getT } from '@gitroom/react/translation/get.translation.service.backend';

export const dynamic = 'force-dynamic';
import { ReactNode } from 'react';
import loadDynamic from 'next/dynamic';
import { LogoTextComponent } from '@gitroom/frontend/components/ui/logo-text.component';
import { MantineWrapper } from '@gitroom/react/helpers/mantine.wrapper';
import { Toaster } from '@gitroom/react/toaster/toaster';
const ReturnUrlComponent = loadDynamic(() => import('./return.url.component'));
export default async function AuthLayout({
  children,
}: {
  children: ReactNode;
}) {
  const t = await getT();

  return (
    <MantineWrapper>
      <Toaster />
      <div className="bg-[#0E0E0E] flex flex-1 p-[12px] gap-[12px] min-h-screen w-screen text-white">
        {/*<style>{`html, body {overflow-x: hidden;}`}</style>*/}
        <ReturnUrlComponent />
        <div className="flex flex-col py-[40px] px-[20px] flex-1 lg:w-[600px] lg:flex-none rounded-[12px] text-white p-[12px] bg-[#1A1919]">
          <div className="w-full max-w-[440px] mx-auto justify-center gap-[20px] h-full flex flex-col text-white">
            <LogoTextComponent />
            <div className="flex">{children}</div>
          </div>
        </div>
        {/* FORK: brand - the Alpine Socials logo and tagline instead of the
            Postiz testimonials */}
        <div className="flex-1 hidden lg:flex flex-col items-center justify-center gap-[32px]">
          <img
            src="/alpine-logo-white.svg"
            alt="Alpine Socials"
            className="w-[420px] max-w-[70%] h-auto"
          />
          <div className="text-[28px] text-center max-w-[560px]">
            {t(
              'brand_tagline',
              'Plan, approve and publish your social media in one place'
            )}
          </div>
        </div>
      </div>
    </MantineWrapper>
  );
}
