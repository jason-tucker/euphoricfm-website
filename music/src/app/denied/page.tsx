export const dynamic = 'force-dynamic'

const REASONS: Record<string, string> = {
  not_member: 'This portal is for members of the EuphoricFM Discord server.',
  pending: 'Finish Discord membership screening for the EuphoricFM server, then try again.',
  unverifiable: 'We could not confirm your server membership right now. Try again in a minute.',
}

export default async function Denied({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const reason = typeof sp.reason === 'string' ? sp.reason : ''
  return (
    <section className="space-y-3">
      <h1 className="text-xl font-bold text-ruby">Access denied</h1>
      <p>{REASONS[reason] ?? 'Sign-in was not completed.'}</p>
    </section>
  )
}
