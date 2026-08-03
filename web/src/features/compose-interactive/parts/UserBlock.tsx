import { Collapsible } from '@/components/layout/Collapsible'
import { UserFields } from './UserFields'
import type { UserConfig } from '@/store'

const DEFAULT_USER: UserConfig = {
  name: '',
  password: '',
  hashAlgo: 'sha512',
  groups: [],
  sudo: false,
  home: '',
  shell: '/bin/bash',
}


export function UserBlock({
  user,
  onChange,
}: {
  user: UserConfig | null
  onChange: (u: UserConfig | null) => void
}) {
  const enabled = user !== null
  const patch = (p: Partial<UserConfig>) =>
    onChange({ ...(user ?? DEFAULT_USER), ...p })
  // While Collapsible is animating the exit, `user` has already flipped to
  // null (the parent set it on checkbox uncheck). The fields still need
  // something to render against for those ~260ms. Fall back to the last
  // meaningful value or the DEFAULT_USER template so field inputs don't
  // throw during the close animation.
  const displayUser: UserConfig = user ?? DEFAULT_USER
  return (
    <div>
      <label
        className="flex cursor-pointer items-center gap-3 text-sm"
        style={{ color: 'var(--font-color)' }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) =>
            e.target.checked ? onChange({ ...DEFAULT_USER }) : onChange(null)
          }
          className="h-4 w-4 accent-[var(--classic-blue)] cursor-pointer"
        />
        Enable a default user
      </label>
      <Collapsible open={enabled} className="mt-3">
        <UserFields displayUser={displayUser} patch={patch} />
      </Collapsible>
    </div>
  )
}
