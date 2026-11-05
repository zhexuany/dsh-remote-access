/**
 * The Harness API asks `connection.trustedHosts` about every request, and that
 * field is a live plain array, so a same-process plugin can publish the tunnel
 * authority at runtime instead of editing the boot-time runtime patch.
 */
export class FenceKeeper {
  constructor(connection, logger) {
    this.connection = connection
    this.logger = logger
    this.added = new Set()
  }

  /** @returns {boolean} whether the authority is now accepted by the fence. */
  add(authority) {
    if (!authority) return false
    const target = this.connection?.trustedHosts
    if (!Array.isArray(target)) {
      this.logger?.warn(`connection.trustedHosts is not an array; cannot trust ${authority}`)
      return false
    }
    if (target.includes(authority)) {
      this.added.add(authority)
      return true
    }
    target.push(authority)
    this.added.add(authority)
    this.logger?.info(`API trust fence: added ${authority}`)
    return true
  }

  remove(authority) {
    if (!authority) return
    this.added.delete(authority)
    const target = this.connection?.trustedHosts
    if (!Array.isArray(target)) return
    const index = target.lastIndexOf(authority)
    if (index === -1) return
    target.splice(index, 1)
    this.logger?.info(`API trust fence: removed ${authority}`)
  }

  /** Drop every authority this plugin added; boot-time entries stay untouched. */
  clear() {
    for (const authority of [...this.added]) this.remove(authority)
  }

  get entries() {
    return [...this.added]
  }
}
