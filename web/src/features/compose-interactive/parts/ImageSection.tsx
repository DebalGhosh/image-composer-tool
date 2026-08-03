import { Card } from '@/components/layout/Card'
import {
  TextInput,
  fieldLabelClass,
  fieldLabelStyle,
} from '@/components/controls/Select'

/** Image name + version. Name validation lives in the container. */
export function ImageSection({
  imageName,
  imageVersion,
  onNameChange,
  onVersionChange,
  imageNameInvalid,
}: {
  imageName: string
  imageVersion: string
  onNameChange: (v: string) => void
  onVersionChange: (v: string) => void
  /** True when imageName fails IMAGE_NAME_RE — validated by the container. */
  imageNameInvalid: boolean
}) {
  return (
            <Card
              title="Image"
              titleStyle="section"
              collapsible
              className="mb-4"
            >
              <div className="mb-4">
                <label
                  htmlFor="i-image-name"
                  className={fieldLabelClass}
                  style={fieldLabelStyle}
                >
                  Image name
                </label>
                <TextInput
                  id="i-image-name"
                  value={imageName}
                  onChange={(e) => onNameChange(e.target.value)}
                  placeholder="my-image"
                  aria-invalid={imageNameInvalid || undefined}
                  style={
                    imageNameInvalid
                      ? { borderColor: 'var(--danger)' }
                      : undefined
                  }
                />
                {imageNameInvalid && (
                  <p className="mt-1 text-xs" style={{ color: 'var(--danger-fg)' }}>
                    Must be alphanumeric with <code>-</code> or <code>_</code>{' '}
                    between; must start and end with an alnum character.
                  </p>
                )}
              </div>
              <div>
                <label
                  htmlFor="i-image-version"
                  className={fieldLabelClass}
                  style={fieldLabelStyle}
                >
                  Image version
                </label>
                <TextInput
                  id="i-image-version"
                  value={imageVersion}
                  onChange={(e) => onVersionChange(e.target.value)}
                  placeholder="1.0.0"
                />
              </div>
            </Card>
  )
}
