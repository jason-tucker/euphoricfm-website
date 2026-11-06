'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Notice } from '../ui'
import { DecisionPanel } from './DecisionPanel'

export function ReviewItemActions({ nextHref, ...props }: Omit<React.ComponentProps<typeof DecisionPanel>, 'onDecided'> & { nextHref: string }) {
  const router = useRouter()
  const [done, setDone] = useState<'approved' | 'denied' | null>(null)
  if (done) {
    return (
      <Notice tone="ok">
        <p className="font-semibold">{done === 'approved' ? 'Approved.' : 'Denied. The submitter will see your reason.'}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link href={nextHref} className="btn btn-primary btn-sm">
            Next pending item
          </Link>
          <Link href="/review" className="btn btn-secondary btn-sm">
            Back to the queue
          </Link>
        </div>
      </Notice>
    )
  }
  return (
    <DecisionPanel
      {...props}
      onDecided={(s) => {
        setDone(s)
        router.refresh()
      }}
    />
  )
}
