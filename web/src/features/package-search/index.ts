/**
 * package-search — inline combobox + expanded dialog over ict-pkgsvc.
 *
 * Both surfaces are public because InteractivePage mounts both: the compact
 * combobox inline, and the dialog via "Advanced search" / Cmd+K.
 *
 * packageSearchShared is deliberately NOT re-exported. It exists so the two
 * surfaces cannot diverge on arch normalisation, group buckets and MiniSearch
 * config; exporting it would invite a third consumer to depend on those
 * internals rather than on a component.
 */
export { PackageSearchCombobox } from './PackageSearchCombobox'
export { PackageSearchDialog } from './PackageSearchDialog'
