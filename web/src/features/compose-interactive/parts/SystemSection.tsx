import { Card } from '@/components/layout/Card'
import {
  TextInput,
  fieldLabelClass,
  fieldLabelStyle,
} from '@/components/controls/Select'
import type { UserConfig } from '@/store'
import { UserBlock } from './UserBlock'

/** Hostname plus the optional default-user block. */
export function SystemSection({
  hostname,
  onHostnameChange,
  user,
  onUserChange,
}: {
  hostname: string
  onHostnameChange: (v: string) => void
  user: UserConfig | null
  onUserChange: (u: UserConfig | null) => void
}) {
  return (
            <Card
              title="System"
              titleStyle="section"
              collapsible
              className="mb-4"
            >
              <div className="mb-4">
                <label
                  htmlFor="i-hostname"
                  className={fieldLabelClass}
                  style={fieldLabelStyle}
                >
                  Hostname
                </label>
                <TextInput
                  id="i-hostname"
                  value={hostname}
                  onChange={(e) => onHostnameChange(e.target.value)}
                  placeholder="my-host"
                />
              </div>
              <UserBlock
                user={user}
                onChange={onUserChange}
              />
            </Card>
  )
}
