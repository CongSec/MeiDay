const DB_NAME = 'easytask'
const DB_VERSION = 5

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = req.result
      const oldVersion = (e as IDBVersionChangeEvent).oldVersion
      if (!db.objectStoreNames.contains('profile')) db.createObjectStore('profile')
      if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks')
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
      if (!db.objectStoreNames.contains('trash')) db.createObjectStore('trash')
      if (!db.objectStoreNames.contains('repeats')) db.createObjectStore('repeats')
      // v3 之前 tasks/trash 缓存未按用户名命名空间，无法归属到具体账号；
      // 升级时一次性清空这些“孤儿”缓存，避免登出/换号后残留脏数据。
      // 注意：onupgradeneeded 内连接仍处于 versionchange 状态，不能用 db.transaction()
      // 开新事务（会抛错导致版本变更事务被中止），必须复用升级事务 req.transaction。
      // 全新数据库（oldVersion === 0）时各仓库刚建好为空，无需清理。
      if (oldVersion > 0 && oldVersion < 4) {
        const tx = req.transaction!
        tx.objectStore('tasks').clear()
        tx.objectStore('trash').clear()
      }
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

export async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb()
  const plain = JSON.parse(JSON.stringify(value))
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(plain, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function idbDel(store: string, key: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 删除某个 store 中 key 以给定前缀开头的所有记录 */
function idbDeletePrefix(store: IDBObjectStore, prefix: string): void {
  const req = store.openCursor()
  req.onsuccess = () => {
    const cursor = req.result
    if (!cursor) return
    if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) cursor.delete()
    cursor.continue()
  }
}

/**
 * 清除指定用户在本浏览器上的全部本地缓存（tasks / trash / profile / kv etag）。
 * 用于登出、会话失效（401）等场景，避免旧缓存残留，防止下次登录把过期数据当作
 * 权威数据展示或再次同步回服务端造成冲突。
 */
export async function idbClearUserCache(username: string): Promise<void> {
  if (!username) return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['tasks', 'trash', 'profile', 'kv', 'repeats'], 'readwrite')
    const prefix = `${username}:`
    idbDeletePrefix(tx.objectStore('tasks'), `tasks:${prefix}`)
    idbDeletePrefix(tx.objectStore('trash'), `trash:${prefix}`)
    idbDeletePrefix(tx.objectStore('repeats'), `repeats:${prefix}`)
    idbDeletePrefix(tx.objectStore('kv'), `etag:${prefix}`)
    // profile 直接用用户名作 key
    tx.objectStore('profile').delete(username)
    // 统计缓存：key 为 `stats:{username}`
    idbDeletePrefix(tx.objectStore('kv'), `stats:${username}`)
    // 同步游标：登出即清除，下次登录以全量同步为准（本地数据缓存已清空，增量会漏未变化项目）
    idbDeletePrefix(tx.objectStore('kv'), `sync:version:${username}`)
    // 注意：sync:pending:{username}（待发上报队列）刻意保留，登出时先尽力冲刷；
    // 若当时离线，下次同账号登录会补报，避免其它设备漏掉这次变更。

    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
