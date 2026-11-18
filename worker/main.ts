import type { OrcaWorkerApi } from 'orca/worker'

export default async function activate(orca: OrcaWorkerApi) {
  orca.log('peon-ping worker started')
}
