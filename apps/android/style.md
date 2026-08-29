# OpenClaw Android UI Style Guide

Scope: all native Android UI in `apps/android` (Jetpack Compose).
Goal: one coherent visual system across onboarding, settings, and future screens.

## 1. Design Direction

- Clean, quiet surfaces.
- Strong readability first.
- One clear primary action per screen state.
- Progressive disclosure for advanced controls.
- Deterministic flows: validate early, fail clearly.

## 2. Style Baseline

The Control UI palette is authoritative. The Android app shares its colors with the
Control UI so one product does not read as two, and keeps its own native geometry:
compact spacing, phone-sized touch targets, and a bottom navigation bar. Do not copy
the Control UI web layout.

Baseline traits:

- Dark canvas with a slight blue cast; panels barely lighter than the canvas.
- Red accent for the current page, the selected state, and the primary action.
- Hairline borders and layered surfaces for structure; near-zero shadow.
- Medium/semibold typography (no thin text).
- Divider-and-spacing layout over card nesting.

## 3. Core Tokens

These are the shared Control UI tokens. Dark is the default theme; light mirrors the
same hierarchy and the same red accent family on a neutral canvas.

Dark (default):

- Canvas: `#0E1015`
- Card surface: `#161920`
- Elevated surface: `#191C24`
- Pressed/hover surface: `#1F2330`
- Border: `#1E2028`
- Border strong: `#2E3040`
- Text strong: `#F4F4F5`
- Text body: `#BCBCC0`
- Text muted: `#8B8B94`
- Accent: `#FF5C5C`
- Accent soft: accent at about 10 percent opacity
- Primary button: `#D13C3C`
- Secondary accent: `#14B8A6`
- Success `#22C55E`, warning `#F59E0B`, danger `#F87171`

Light:

- Canvas `#F7F7F9`, surface `#FFFFFF`, pressed `#EFEFF3`
- Border `#E4E4EA`, border strong `#CFCFD8`
- Text `#101014` / `#52525B` / `#787885`
- Accent and primary button `#C23434`, secondary accent `#0F8F81`
- Success `#15803D`, warning `#B45309`, danger `#B91C1C`

Rules:

- Do not introduce per-screen colors when a token fits; there is no second palette.
- Soft status and accent fills are alpha-based so one token composites over canvas,
  card, and row surfaces.
- Do not rely on the Material default color roles. `ClawTheme.kt` maps every token
  into `MaterialTheme`, including the container roles Material uses for selection.

## 4. Typography

Primary type family: Manrope (`400/500/600/700`).

Recommended scale:

- Display: `34sp / 40sp`, bold
- Section title: `24sp / 30sp`, semibold
- Headline/action: `16sp / 22sp`, semibold
- Body: `15sp / 22sp`, medium
- Callout/helper: `14sp / 20sp`, medium
- Caption 1: `12sp / 16sp`, medium
- Caption 2: `11sp / 14sp`, medium

Use monospace only for commands, setup codes, endpoint-like values.
Hard rule: avoid ultra-thin weights on light backgrounds.

## 5. Layout And Spacing

- Respect safe drawing insets.
- Keep content hierarchy mostly via spacing + dividers.
- Prefer vertical rhythm from `8/10/12/14/20dp`.
- Radius scale: `6dp` rows and chips, `10dp` controls and buttons, `14dp` panels,
  `20dp` sheets and pills.
- Panels are a flat surface plus a 1dp border. Do not add tonal or shadow elevation,
  and do not nest a panel inside a panel.
- Shell pages open with a page header: an action row, then the page name in the accent
  color on its own full-width line. Product branding does not repeat per page.
- Prefer one bordered list over a grid of cards for status and reference data.

## 6. Buttons And Actions

- Primary action: filled accent button, visually dominant.
- Secondary action: lower emphasis (outlined/text/surface button).
- Icon-only buttons must remain legible and >=44dp target.
- Back buttons in action rows use rounded-square shape, not circular by default.

## 7. Inputs And Forms

- Always show explicit label or clear context title.
- Keep helper copy short and actionable.
- Validate before advancing steps.
- Prefer immediate inline errors over hidden failure states.
- Keep optional advanced fields explicit (`Manual`, `Advanced`, etc.).

## 8. Progress And Multi-Step Flows

- Use clear step count (`Step X of N`).
- Use labeled progress rail/indicator when steps are discrete.
- Keep navigation predictable: back/next behavior should never surprise.

## 9. Accessibility

- Minimum practical touch target: `44dp`.
- Bottom navigation shows every destination label, always, not only the selected one.
- Do not rely on color alone for status.
- Preserve high contrast for all text tiers.
- Add meaningful `contentDescription` for icon-only controls.

## 10. Architecture Rules

- Durable UI state in `MainViewModel`.
- Composables: state in, callbacks out.
- No business/network logic in composables.
- Keep side effects explicit (`LaunchedEffect`, activity result APIs).

## 11. Source Of Truth

Tokens and shared components:

- `app/src/main/java/ai/openclaw/app/ui/design/ClawTheme.kt` (palette, spacing, radii,
  type, and the Material color-scheme bridge)
- `app/src/main/java/ai/openclaw/app/ui/MobileUiTokens.kt` (legacy token set, same palette)
- `app/src/main/java/ai/openclaw/app/ui/design/ClawSurfaces.kt`
- `app/src/main/java/ai/openclaw/app/ui/design/ClawComponents.kt`
- `app/src/main/java/ai/openclaw/app/ui/design/ClawNavigation.kt`

Shell and screens:

- `app/src/main/java/ai/openclaw/app/ui/SidebarShell.kt`
- `app/src/main/java/ai/openclaw/app/ui/SidebarContent.kt`
- `app/src/main/java/ai/openclaw/app/ui/ShellScreen.kt`
- `app/src/main/java/ai/openclaw/app/ui/OnboardingFlow.kt`
- `app/src/main/java/ai/openclaw/app/MainViewModel.kt`

If style and implementation diverge, update both in the same change.
