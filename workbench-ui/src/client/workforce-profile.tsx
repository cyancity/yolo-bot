/**
 * WorkforceProfile：用户个人资料组件与状态。
 * - 默认名称为「用户」，默认头像为插画风动漫人物头像。
 * - 支持修改昵称、挑选预设插画头像、上传本地图片自定义头像。
 * - 本地持久化，全局同步（useSyncExternalStore）。
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import css from './workforce-profile.module.css'
import { WF } from './workforce-strings.ts'
import { DEFAULT_USER_AVATAR_DATA_URL } from './workforce-user-avatar.ts'
export { DEFAULT_USER_AVATAR_DATA_URL } from './workforce-user-avatar.ts'

export interface UserProfile {
  readonly name: string
  readonly avatarUrl?: string | undefined
  readonly isCustomAvatar?: boolean | undefined
}

// 预设插画风头像 SVG 候选（冷峻动漫/赛博风格，高辨识度矢量插画）
export const PRESET_AVATARS = [
  {
    id: 'cyber-default',
    get name() { return WF.userProfile.presetCyberDefault },
    svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#181a20"/><stop offset="100%" stop-color="#0f1115"/></linearGradient>
        <linearGradient id="neon" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#4facfe"/></linearGradient>
        <linearGradient id="face" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffd5c0"/><stop offset="100%" stop-color="#e2ab90"/></linearGradient>
      </defs>
      <rect width="100" height="100" fill="url(#bg)"/>
      <circle cx="50" cy="50" r="46" fill="none" stroke="url(#neon)" stroke-width="2.5" opacity="0.6"/>
      <!-- 身体与高领外套 -->
      <path d="M18 96 C24 74 38 68 50 68 C62 68 76 74 82 96 Z" fill="#242731"/>
      <path d="M36 70 L50 82 L64 70 L58 96 L42 96 Z" fill="#1b1d24"/>
      <path d="M48 76 L52 76 L51 96 L49 96 Z" fill="url(#neon)"/>
      <!-- 脸与脖子 -->
      <path d="M42 54 L50 65 L58 54 Z" fill="#c9957d"/>
      <path d="M34 36 C34 54 44 62 50 62 C56 62 66 54 66 36 C66 22 56 22 50 22 C44 22 34 22 34 36 Z" fill="url(#face)"/>
      <!-- 冷峻银发 -->
      <path d="M30 36 C28 20 40 12 50 12 C62 12 72 20 70 36 C68 28 62 20 50 20 C38 20 32 28 30 36 Z" fill="#e2e8f0"/>
      <path d="M32 30 L38 42 L42 32 L48 44 L52 28 L56 42 L62 30 L66 40 L68 28 C64 16 56 14 50 14 C40 14 34 20 32 30 Z" fill="#cbd5e1"/>
      <!-- 战术目镜/眼部 -->
      <rect x="36" y="38" width="28" height="7" rx="3.5" fill="#111317"/>
      <rect x="38" y="39.5" width="24" height="4" rx="2" fill="url(#neon)"/>
      <!-- 耳机 -->
      <rect x="29" y="36" width="5" height="12" rx="2.5" fill="#333846"/>
      <circle cx="31.5" cy="42" r="1.5" fill="#00f2fe"/>
      <rect x="66" y="36" width="5" height="12" rx="2.5" fill="#333846"/>
      <circle cx="68.5" cy="42" r="1.5" fill="#00f2fe"/>
    </svg>`,
  },
  {
    id: 'shadow-tactical',
    get name() { return WF.userProfile.presetShadowTactical },
    svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg2" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#111827"/><stop offset="100%" stop-color="#030712"/></linearGradient>
        <linearGradient id="coral" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#fb7185"/></linearGradient>
      </defs>
      <rect width="100" height="100" fill="url(#bg2)"/>
      <circle cx="50" cy="50" r="46" fill="none" stroke="url(#coral)" stroke-width="2" opacity="0.5"/>
      <path d="M16 98 C22 72 36 66 50 66 C64 66 78 72 84 98 Z" fill="#1f2937"/>
      <path d="M38 40 C38 56 46 62 50 62 C54 62 62 56 62 40 C62 26 54 24 50 24 C46 24 38 26 38 40 Z" fill="#fed7aa"/>
      <!-- 黑发斜刘海 -->
      <path d="M34 38 C32 22 42 16 50 16 C60 16 68 22 66 38 L62 34 L56 46 L50 28 L44 44 L38 32 Z" fill="#0f172a"/>
      <!-- 犀利眼神 -->
      <path d="M41 42 L46 41" stroke="#0f172a" stroke-width="2" stroke-linecap="round"/>
      <path d="M54 41 L59 42" stroke="#0f172a" stroke-width="2" stroke-linecap="round"/>
      <circle cx="43.5" cy="44" r="1.8" fill="url(#coral)"/>
      <circle cx="56.5" cy="44" r="1.8" fill="url(#coral)"/>
      <!-- 黑色面罩 -->
      <path d="M39 50 L50 56 L61 50 L60 62 L40 62 Z" fill="#111827"/>
    </svg>`,
  },
  {
    id: 'cyber-violet',
    get name() { return WF.userProfile.presetCyberViolet },
    svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg3" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1e1b4b"/><stop offset="100%" stop-color="#0f0e26"/></linearGradient>
        <linearGradient id="purp" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#a855f7"/><stop offset="100%" stop-color="#ec4899"/></linearGradient>
      </defs>
      <rect width="100" height="100" fill="url(#bg3)"/>
      <circle cx="50" cy="50" r="46" fill="none" stroke="url(#purp)" stroke-width="2" opacity="0.6"/>
      <path d="M18 96 C24 74 38 68 50 68 C62 68 76 74 82 96 Z" fill="#312e81"/>
      <path d="M36 38 C36 55 45 62 50 62 C55 62 64 55 64 38 C64 24 55 22 50 22 C45 22 36 24 36 38 Z" fill="#fbcfe8"/>
      <!-- 浅紫挑染发型 -->
      <path d="M32 36 C30 20 40 14 50 14 C62 14 70 20 68 36 L64 30 L58 44 L52 26 L46 42 L40 30 Z" fill="#c084fc"/>
      <rect x="38" y="40" width="24" height="5" rx="2.5" fill="url(#purp)"/>
    </svg>`,
  },
  {
    id: 'mono-spec',
    get name() { return WF.userProfile.presetMonoSpec },
    svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" fill="#000000"/>
      <circle cx="50" cy="50" r="46" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.3"/>
      <path d="M18 96 C24 74 38 68 50 68 C62 68 76 74 82 96 Z" fill="#262626"/>
      <path d="M36 38 C36 54 44 62 50 62 C56 62 64 54 64 38 C64 24 56 22 50 22 C44 22 36 24 36 38 Z" fill="#e5e5e5"/>
      <path d="M32 36 C30 20 40 14 50 14 C60 14 70 20 68 36 L62 28 L56 42 L50 26 L44 40 L38 28 Z" fill="#ffffff"/>
      <line x1="40" y1="42" x2="47" y2="42" stroke="#000000" stroke-width="2"/>
      <line x1="53" y1="42" x2="60" y2="42" stroke="#000000" stroke-width="2"/>
    </svg>`,
  },
]

export const DEFAULT_AVATAR_DATA_URL = DEFAULT_USER_AVATAR_DATA_URL

export const DEFAULT_USER_PROFILE: UserProfile = {
  get name() { return WF.userProfile.defaultName },
  avatarUrl: DEFAULT_USER_AVATAR_DATA_URL,
  isCustomAvatar: false,
}

const STORAGE_KEY = 'wb:user-profile:v1'

let cachedProfile: UserProfile | null = null
const profileListeners = new Set<() => void>()

function loadProfileFromStorage(): UserProfile {
  if (typeof window === 'undefined') return DEFAULT_USER_PROFILE
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_USER_PROFILE
    const parsed = JSON.parse(raw) as Partial<UserProfile>
    const isOldSvgDefault = typeof parsed.avatarUrl === 'string' && parsed.avatarUrl.startsWith('data:image/svg+xml')
    const hasCustomName = typeof parsed.name === 'string' && parsed.name.trim() !== '' && parsed.name.trim() !== '用户'
    return {
      get name() { return hasCustomName ? (parsed.name as string).trim() : WF.userProfile.defaultName },
      avatarUrl: typeof parsed.avatarUrl === 'string' && parsed.avatarUrl !== '' && !isOldSvgDefault ? parsed.avatarUrl : DEFAULT_USER_AVATAR_DATA_URL,
      isCustomAvatar: Boolean(parsed.isCustomAvatar) && !isOldSvgDefault,
    }
  } catch {
    return DEFAULT_USER_PROFILE
  }
}

export function getUserProfile(): UserProfile {
  if (cachedProfile === null) {
    cachedProfile = loadProfileFromStorage()
  }
  return cachedProfile
}

export function setUserProfile(patch: Partial<UserProfile>): UserProfile {
  const current = getUserProfile()
  const next: UserProfile = {
    name: patch.name !== undefined && patch.name.trim() !== '' ? patch.name.trim() : current.name,
    avatarUrl: patch.avatarUrl !== undefined ? patch.avatarUrl : current.avatarUrl,
    isCustomAvatar: patch.isCustomAvatar !== undefined ? patch.isCustomAvatar : current.isCustomAvatar,
  }
  cachedProfile = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 忽略存储配额异常
  }
  profileListeners.forEach(listener => listener())
  return next
}

function subscribeUserProfile(listener: () => void): () => void {
  profileListeners.add(listener)
  return () => {
    profileListeners.delete(listener)
  }
}

/** React hook 订阅用户资料变化 */
export function useUserProfile(): UserProfile {
  return useSyncExternalStore(subscribeUserProfile, getUserProfile, () => DEFAULT_USER_PROFILE)
}

/** 获取用户显示名字（保证响应式） */
export function useUserDisplayName(): string {
  const profile = useUserProfile()
  return profile.name || WF.userProfile.defaultName
}

/** 用户头像渲染组件 */
export function UserProfileAvatar({
  profile,
  size = 32,
  className,
}: {
  readonly profile?: UserProfile | undefined
  readonly size?: number | undefined
  readonly className?: string | undefined
}) {
  const current = profile ?? useUserProfile()
  const avatarUrl = current.avatarUrl || DEFAULT_AVATAR_DATA_URL
  const name = current.name || WF.userProfile.defaultName

  return (
    <div
      className={`${css.avatarContainer} ${className ?? ''}`}
      style={{ width: `${size}px`, height: `${size}px`, borderRadius: '50%' }}
      title={name}
    >
      <img
        src={avatarUrl}
        alt={name}
        className={css.avatarImg}
        style={{ borderRadius: '50%', objectFit: 'cover' }}
        onError={e => {
          // 图片加载失败时回退到默认插画
          e.currentTarget.src = DEFAULT_AVATAR_DATA_URL
        }}
      />
    </div>
  )
}

/** 侧栏底部用户状态条（点击打开资料设置弹窗） */
export function UserProfileBar({
  onOpenSettings,
}: {
  readonly onOpenSettings?: (() => void) | undefined
}) {
  const profile = useUserProfile()
  const [modalOpen, setModalOpen] = useState(false)

  const handleOpen = () => {
    if (onOpenSettings) onOpenSettings()
    else setModalOpen(true)
  }

  return (
    <>
      <div
        className={css.userBar}
        role="button"
        tabIndex={0}
        aria-label={WF.common.userProfileAria}
        onClick={handleOpen}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleOpen()
          }
        }}
      >
        <div className={css.userBarAvatarWrap}>
          <UserProfileAvatar profile={profile} size={30} />
        </div>
        <div className={css.userBarInfo}>
          <span className={css.userBarName}>{profile.name}</span>
          <span className={css.userBarStatus}>
            <span className={css.statusDot} aria-hidden="true" />
            {WF.userProfile.online}
          </span>
        </div>
        <div className={css.userBarActions} title={WF.userProfile.editProfile}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </div>
      </div>

      {modalOpen && <UserProfileModal onClose={() => setModalOpen(false)} />}
    </>
  )
}

/** 用户资料编辑模态弹窗 */
export function UserProfileModal({
  onClose,
}: {
  readonly onClose: () => void
}) {
  const profile = useUserProfile()
  const [name, setName] = useState(profile.name)
  const [avatarUrl, setAvatarUrl] = useState(profile.avatarUrl || DEFAULT_AVATAR_DATA_URL)
  const [isCustom, setIsCustom] = useState(profile.isCustomAvatar || false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const res = await fetch('/wb/api/workforce/profile')
        const body = (await res.json()) as { ok: boolean; data?: { profile?: { name?: string; avatarUrl?: string } } }
        if (active && body.ok && body.data?.profile) {
          const p = body.data.profile
          if (p.name) setName(p.name)
          if (p.avatarUrl) {
            setAvatarUrl(p.avatarUrl)
            setIsCustom(true)
          }
        }
      } catch {
        // 忽略
      }
    })()
    return () => { active = false }
  }, [])

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 8 * 1024 * 1024) {
      alert(WF.userProfile.avatarSizeLimit)
      return
    }

    // 先尝试通过宿主 /wb/api/workforce/materials 上传原始字节
    void (async () => {
      try {
        const res = await fetch('/wb/api/workforce/materials', {
          method: 'POST',
          headers: {
            'content-type': file.type || 'application/octet-stream',
            'x-workforce-filename': encodeURIComponent(file.name),
          },
          body: file,
        })
        const body = (await res.json()) as { ok: boolean; data?: { material?: { url: string } } }
        if (body.ok && body.data?.material?.url) {
          setAvatarUrl(body.data.material.url)
          setIsCustom(true)
          return
        }
      } catch {
        // 宿主接口未就绪时回退到本地 FileReader
      }

      const reader = new FileReader()
      reader.onload = evt => {
        const result = evt.target?.result
        if (typeof result === 'string') {
          setAvatarUrl(result)
          setIsCustom(true)
        }
      }
      reader.readAsDataURL(file)
    })()
  }

  const handlePickPreset = (svg: string) => {
    const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
    setAvatarUrl(dataUrl)
    setIsCustom(false)
  }

  const handleReset = () => {
    setName(WF.userProfile.defaultName)
    setAvatarUrl(DEFAULT_AVATAR_DATA_URL)
    setIsCustom(false)
  }

  const handleSave = async () => {
    const trimmed = name.trim() || WF.userProfile.defaultName
    try {
      const isMaterial = avatarUrl.startsWith('/wb/api/workforce/materials/')
      await fetch('/wb/api/workforce/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          avatarUrl: isMaterial ? avatarUrl : (avatarUrl === DEFAULT_AVATAR_DATA_URL ? null : avatarUrl),
        }),
      })
    } catch {
      // 容错
    }

    setUserProfile({
      name: trimmed,
      avatarUrl,
      isCustomAvatar: isCustom,
    })
    onClose()
  }
  const modalContent = (
    <div className={css.modalOverlay} onClick={onClose}>
      <div
        className={css.profileDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={inputId}
        onClick={e => e.stopPropagation()}
      >
        <div className={css.modalHeader}>
          <h2 id={inputId} className={css.modalTitle}>{WF.userProfile.title}</h2>
          <button type="button" className={css.closeBtn} onClick={onClose} aria-label={WF.common.close}>
            ✕
          </button>
        </div>

        {/* 头像预览与操作 */}
        <div className={css.avatarSection}>
          <div className={css.avatarPreview}>
            <img src={avatarUrl} alt={WF.userProfile.avatarPreview} className={css.avatarImg} />
          </div>
          <div className={css.avatarControls}>
            <div className={css.avatarBtnRow}>
              <button
                type="button"
                className={css.uploadBtn}
                onClick={() => fileInputRef.current?.click()}
              >
                {WF.userProfile.uploadCustom}
              </button>
              <button
                type="button"
                className={css.resetBtn}
                onClick={handleReset}
              >
                {WF.userProfile.reset}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                style={{ display: 'none' }}
                onChange={handleFileUpload}
              />
            </div>
            <div className={css.avatarHint}>{WF.userProfile.avatarFormatHint}</div>
          </div>
        </div>

        {/* 预设动漫插画头像选择 */}
        <div className={css.presetSection}>
          <div className={css.presetTitle}>{WF.userProfile.featuredAvatars}</div>
          <div className={css.presetGrid}>
            {PRESET_AVATARS.map(item => {
              const itemUrl = `data:image/svg+xml;utf8,${encodeURIComponent(item.svg)}`
              const isActive = avatarUrl === itemUrl
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`${css.presetItem} ${isActive ? css.presetItemActive : ''}`}
                  title={item.name}
                  onClick={() => handlePickPreset(item.svg)}
                >
                  <img src={itemUrl} alt={item.name} className={css.avatarImg} />
                </button>
              )
            })}
          </div>
        </div>

        {/* 名字输入 */}
        <div className={css.formSection}>
          <label htmlFor="user-profile-name-input" className={css.fieldLabel}>{WF.userProfile.displayName}</label>
          <input
            id="user-profile-name-input"
            type="text"
            className={css.input}
            value={name}
            maxLength={32}
            placeholder={WF.userProfile.namePlaceholder}
            onChange={e => setName(e.target.value)}
          />
        </div>

        {/* 底部按钮 */}
        <div className={css.modalFooter}>
          <button type="button" className={css.cancelBtn} onClick={onClose}>
            {WF.common.cancel}
          </button>
          <button type="button" className={css.saveBtn} onClick={handleSave}>
            {WF.common.save}
          </button>
        </div>
      </div>
    </div>
  )
  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : modalContent
}
