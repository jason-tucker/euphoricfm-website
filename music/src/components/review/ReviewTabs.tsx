import Link from 'next/link'

export function ReviewTabs({ active }: { active: 'submissions' | 'requests' }) {
  const tab = (key: typeof active, href: string, label: string) => (
    <Link href={href} className="nav-link" aria-current={active === key ? 'page' : undefined}>
      {label}
    </Link>
  )
  return (
    <nav aria-label="Review sections" className="mb-5 flex gap-1 border-b border-cream/10 pb-2">
      {tab('submissions', '/review', 'Submissions')}
      {tab('requests', '/review/requests', 'Edit & removal requests')}
    </nav>
  )
}
