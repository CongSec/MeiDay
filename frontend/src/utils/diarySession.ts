/** 隐私日记：纯内存会话（密码 / DEK 永不落盘）。
 *  刷新 / 关闭标签页 / 退出系统 / 空闲锁定 都会清空本模块，需重新输入密码。 */
let dek: Uint8Array | null = null
let unlocked = false
/** 从 Sidebar 点击「隐私日记模式」时置位；刷新后自然消失，用于路由守卫放行密码页 */
let entryIntent = false

export function setDiaryDek(value: Uint8Array | null): void {
  dek = value
  unlocked = value !== null
}

export function getDiaryDek(): Uint8Array | null {
  return dek
}

export function isDiaryUnlocked(): boolean {
  return unlocked
}

export function clearDiarySession(): void {
  dek = null
  unlocked = false
  entryIntent = false
}

export function setDiaryEntryIntent(value: boolean): void {
  entryIntent = value
}

export function isDiaryEntryIntent(): boolean {
  return entryIntent
}
