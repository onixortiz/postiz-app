export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { BriefsComponent } from '@gitroom/frontend/components/briefs/briefs.component';

// FORK: approvals
export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Alpine Socials' : 'Gitroom'} Briefs`,
  description: '',
};

export default async function Index() {
  if (process.env.APPROVALS_ENABLED !== 'true') {
    return notFound();
  }
  return <BriefsComponent />;
}
