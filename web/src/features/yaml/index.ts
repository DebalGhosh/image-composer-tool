/**
 * yaml — the CodeMirror editor wrapper and its fullscreen registry.
 *
 * FE-7a made good on what the previous version of this comment promised. The
 * registry — a module-level Observer coordinating which single editor may own
 * fullscreen — now lives in `fullscreenRegistry.ts`, because a HOOK EXPORTED
 * FROM A COMPONENT FILE is a smell: nothing about the coordination is
 * React-specific, and YamlEditor is one of its subscribers, not its owner.
 *
 * The barrel is why no consumer had to change. `useYamlFullscreenActive` is
 * still imported from '@/features/yaml' by BasicPage, and its NAME is also
 * referenced in prose by DialogOverlay's `closeOnEscape` doc comment — so the
 * name is part of the public surface even though only one component calls it.
 *
 * parts/ stays private: the toggle glyphs and the imperative fold-gutter marker
 * builder serve YamlEditor alone, and are not promoted to components/ until
 * something outside this feature needs them.
 */
export { YamlEditor } from './YamlEditor'
export { useYamlFullscreenActive } from './fullscreenRegistry'
