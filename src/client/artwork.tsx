import { useId, useState } from 'react'

import type { SkillGlyph, SkillIcon } from '../shared/types.js'

const NAME_RULES: Array<[SkillGlyph, RegExp]> = [
  ['git', /\bgit(hub|lab)?\b|\bcommit\b|\bbranch\b|pull request|\bpr\b|代码仓库/],
  ['security', /security|secure|audit|vulnerab|guard|安全|审计|漏洞/],
  ['test', /\btest(s|ing)?\b|\bqa\b|测试/],
  ['deploy', /deploy|docker|kubernetes|\bci\b|\bshell\b|terminal|运维|部署/],
  ['data', /\bdata\b|sql|csv|analytics|database|chart|数据|报表/],
  ['image', /image|figma|design|\bui\b|\bux\b|photo|\bsvg\b|图片|设计/],
  ['web', /\bweb\b|browser|http|frontend|html|\bcss\b|scrape|爬虫|网页/],
  ['doc', /\bdocs?\b|readme|markdown|\bpdf\b|\bword\b|writing|write|文档|写作/],
  ['search', /search|research|retriev|检索|搜索/],
  ['agent', /\bagent\b|\bmcp\b|skill|plugin|prompt|智能体|技能|插件/],
  ['code', /code|coding|develop|typescript|javascript|python|react|vue|node|代码|开发/],
]

const DESC_RULES = NAME_RULES.filter(([glyph]) => glyph !== 'code')

const PALETTES: Record<SkillGlyph, [string, string, string]> = {
  code: ['#69B9FF', '#324DE2', '#A797FC'],
  git: ['#7CB7FF', '#4561EE', '#54ECE7'],
  doc: ['#7CB7FF', '#3650DE', '#69B9FF'],
  data: ['#69B9FF', '#324DE2', '#45D9E7'],
  image: ['#F2AF63', '#C25E22', '#F58EA8'],
  web: ['#67C7FE', '#3F77D8', '#45D9E7'],
  security: ['#45E7A4', '#05909D', '#54ECE7'],
  test: ['#45D9E7', '#0E7490', '#69B9FF'],
  deploy: ['#7AC2FF', '#4A65E8', '#45D9E7'],
  search: ['#41E1AC', '#658EFF', '#658EFF'],
  agent: ['#A797FC', '#4561EE', '#45D9E7'],
  generic: ['#69B9FF', '#324DE2', '#54ECE7'],
}

export function inferGlyph(name: string, description = '', topics: string[] = []): SkillGlyph | undefined {
  const head = [name, ...topics].join(' ').toLowerCase()
  for (const [glyph, rule] of NAME_RULES) {
    if (rule.test(head)) return glyph
  }
  const body = description.toLowerCase()
  for (const [glyph, rule] of DESC_RULES) {
    if (rule.test(body)) return glyph
  }
  return undefined
}

function GlyphArt({ glyph }: { glyph: SkillGlyph }): JSX.Element {
  const uid = `dsc_art_${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const gradient = `url(#${uid}g)`
  const [light, deep, extra] = PALETTES[glyph]

  const shapes: Record<SkillGlyph, JSX.Element> = {
    code: (
      <>
        <path d="M13 9.5 7.5 18l5.5 8.5" stroke={gradient} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M23 9.5l5.5 8.5L23 26.5" stroke={gradient} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M20.8 7.5 15.2 28.5" stroke={extra} strokeWidth="3.2" strokeLinecap="round" />
      </>
    ),
    git: (
      <>
        <path d="M11 13v10M11 18h6.5a7.5 7.5 0 0 0 7.5-7.5V10" stroke={gradient} strokeWidth="2.8" strokeLinecap="round" />
        <circle cx="11" cy="9.5" r="3.1" fill={light} />
        <circle cx="11" cy="26.5" r="3.1" fill={deep} />
        <circle cx="25" cy="9.5" r="3.1" fill={extra} />
      </>
    ),
    doc: (
      <>
        <path d="M10.5 7.5A2.5 2.5 0 0 1 13 5h7.8L27 11.2v17.3a2.5 2.5 0 0 1-2.5 2.5h-11a2.5 2.5 0 0 1-2.5-2.5z" fill={gradient} />
        <path d="M20.8 5v4.4a1.8 1.8 0 0 0 1.8 1.8H27" fill="#FFFFFF" fillOpacity=".3" />
        <path d="M14 18.5h8M14 22h8M14 25.5h5" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" opacity=".95" />
      </>
    ),
    data: (
      <>
        <rect x="7.5" y="18" width="5.5" height="10.5" rx="1.8" fill={light} />
        <rect x="15.25" y="12" width="5.5" height="16.5" rx="1.8" fill={gradient} />
        <rect x="23" y="7.5" width="5.5" height="21" rx="1.8" fill={deep} />
      </>
    ),
    image: (
      <>
        <rect x="6.5" y="8.5" width="23" height="19" rx="3.5" fill={gradient} />
        <circle cx="13" cy="15" r="2.5" fill="#FFFFFF" />
        <path d="M9 25.5 16 18.5l4.2 4.2 3.3-3.3 4.5 6.1z" fill="#FFFFFF" fillOpacity=".92" />
      </>
    ),
    web: (
      <>
        <circle cx="18" cy="18" r="10.5" stroke={gradient} strokeWidth="2.8" />
        <path d="M7.5 18h21" stroke={extra} strokeWidth="2.4" />
        <path d="M18 7.5c3.4 3.4 3.4 17.6 0 21M18 7.5c-3.4 3.4-3.4 17.6 0 21" stroke={gradient} strokeWidth="2.2" />
      </>
    ),
    security: (
      <>
        <path d="M18 5.5 28 9.2v7.6c0 6-4.4 10.3-10 12.2-5.6-1.9-10-6.2-10-12.2V9.2z" fill={gradient} fillOpacity=".9" />
        <path d="m13.5 17.5 3.2 3.2 6-6" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    test: (
      <>
        <rect x="9" y="7.5" width="18" height="22" rx="3" fill={gradient} fillOpacity=".9" />
        <rect x="13.5" y="5" width="9" height="5" rx="1.8" fill={extra} />
        <path d="m13.5 17 2.6 2.6 5.4-5.4M13.5 24h9" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    deploy: (
      <>
        <path d="M18 25V6.5M10.5 14 18 6.5l7.5 7.5" stroke={gradient} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9 23.5v3A3.5 3.5 0 0 0 12.5 30h11a3.5 3.5 0 0 0 3.5-3.5v-3" stroke={gradient} strokeWidth="3.2" strokeLinecap="round" />
      </>
    ),
    search: (
      <>
        <circle cx="16" cy="16" r="8.5" stroke={gradient} strokeWidth="3.4" />
        <path d="m22.2 22.2 6.3 6.3" stroke={extra} strokeWidth="3.4" strokeLinecap="round" />
      </>
    ),
    agent: (
      <>
        <path d="M18 18 10.8 10.8M18 18l7.2-7.2M18 18v7.6" stroke={gradient} strokeWidth="2.6" strokeLinecap="round" />
        <rect x="14.5" y="14.5" width="7" height="7" rx="1.8" fill={gradient} />
        <circle cx="10.5" cy="10.5" r="2.5" fill={light} />
        <circle cx="25.5" cy="10.5" r="2.5" fill={extra} />
        <circle cx="18" cy="27" r="2.5" fill={deep} />
      </>
    ),
    generic: (
      <>
        <path d="M18 6.5 28 12l-10 5.5L8 12z" fill={gradient} />
        <path d="M8 16.5 18 22l10-5.5M8 21.5 18 27l10-5.5" stroke={gradient} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  }

  return (
    <svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id={`${uid}g`} x1="7" y1="6" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor={light} />
          <stop offset="1" stopColor={deep} />
        </linearGradient>
      </defs>
      {shapes[glyph]}
    </svg>
  )
}

export function SkillArtwork(props: {
  name: string
  description?: string
  topics?: string[]
  icon?: SkillIcon
  frame?: 'row' | 'card' | 'detail'
}): JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string>()
  const url = props.icon?.url
  const showImage = Boolean(url && failedUrl !== url)
  const glyph = props.icon?.glyph ?? inferGlyph(props.name, props.description, props.topics) ?? 'generic'

  return (
    <span className={`dsc-art is-${props.frame ?? 'row'}${showImage ? ' has-image' : ''}`} aria-hidden="true">
      {showImage && url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <GlyphArt glyph={glyph} />
      )}
    </span>
  )
}
