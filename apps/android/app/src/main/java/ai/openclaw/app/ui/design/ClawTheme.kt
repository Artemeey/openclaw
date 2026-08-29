package ai.openclaw.app.ui.design

import ai.openclaw.app.R
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal val clawFontFamily =
  FontFamily(
    Font(resId = R.font.manrope_400_regular, weight = FontWeight.Normal),
    Font(resId = R.font.manrope_500_medium, weight = FontWeight.Medium),
    Font(resId = R.font.manrope_600_semibold, weight = FontWeight.SemiBold),
    Font(resId = R.font.manrope_700_bold, weight = FontWeight.Bold),
  )

/**
 * App color tokens consumed by ClawTheme and bridged into Material components.
 */
@Immutable
internal data class ClawColors(
  val canvas: Color,
  val surface: Color,
  val surfaceRaised: Color,
  val surfacePressed: Color,
  val accent: Color,
  val accentSoft: Color,
  val accentBorder: Color,
  val border: Color,
  val borderStrong: Color,
  val text: Color,
  val textMuted: Color,
  val textSubtle: Color,
  val primary: Color,
  val primaryText: Color,
  val secondary: Color,
  val success: Color,
  val successSoft: Color,
  val warning: Color,
  val warningSoft: Color,
  val danger: Color,
  val dangerSoft: Color,
  val codeBg: Color,
  val codeText: Color,
  val codeBorder: Color,
)

/**
 * App spacing and control-size scale for Compose screens and shared controls.
 */
@Immutable
internal data class ClawSpacing(
  val xxxs: Dp = 4.dp,
  val xxs: Dp = 8.dp,
  val xs: Dp = 12.dp,
  val sm: Dp = 16.dp,
  val md: Dp = 20.dp,
  val lg: Dp = 24.dp,
  val xl: Dp = 32.dp,
  val xxl: Dp = 40.dp,
  // Touch target and visible shape are separate: `touchTarget` is the minimum
  // hit area every control keeps, while `control`, `row`, `iconSlot`, and `icon`
  // describe the smaller painted geometry that sits inside it.
  val touchTarget: Dp = 48.dp,
  val control: Dp = 36.dp,
  val row: Dp = 48.dp,
  val iconSlot: Dp = 32.dp,
  val icon: Dp = 18.dp,
)

/**
 * Radius scale for rows, panels, controls, sheets, and status pills.
 */
@Immutable
internal data class ClawRadii(
  val row: Dp = 6.dp,
  val control: Dp = 10.dp,
  val button: Dp = 10.dp,
  val panel: Dp = 12.dp,
  val sheet: Dp = 16.dp,
  // Full-round for a `control`-height capsule; larger surfaces use `panel`.
  val pill: Dp = 18.dp,
)

/**
 * App text styles kept independent from Material typography names.
 */
@Immutable
internal data class ClawTypography(
  val display: TextStyle,
  val title: TextStyle,
  val section: TextStyle,
  val body: TextStyle,
  val label: TextStyle,
  val caption: TextStyle,
  val captionSmall: TextStyle,
  val mono: TextStyle,
)

// Control UI palette (canvas #0e1015 through accent #ff5c5c). Soft variants stay
// alpha-based so a tint composites correctly over canvas, panel, and row surfaces.
private val ClawDarkColors =
  ClawColors(
    canvas = Color(0xFF0E1015),
    surface = Color(0xFF161920),
    surfaceRaised = Color(0xFF191C24),
    surfacePressed = Color(0xFF1F2330),
    accent = Color(0xFFFF5C5C),
    accentSoft = Color(0x1AFF5C5C),
    accentBorder = Color(0xFFD13C3C),
    border = Color(0xFF1E2028),
    borderStrong = Color(0xFF2E3040),
    text = Color(0xFFF4F4F5),
    textMuted = Color(0xFFBCBCC0),
    textSubtle = Color(0xFF8B8B94),
    primary = Color(0xFFD13C3C),
    primaryText = Color(0xFFFFFFFF),
    secondary = Color(0xFF14B8A6),
    success = Color(0xFF22C55E),
    successSoft = Color(0x2622C55E),
    warning = Color(0xFFF59E0B),
    warningSoft = Color(0x26F59E0B),
    danger = Color(0xFFF87171),
    dangerSoft = Color(0x26F87171),
    codeBg = Color(0xFF0A0C10),
    codeText = Color(0xFFF4F4F5),
    codeBorder = Color(0xFF1E2028),
  )

// Light mirrors the dark hierarchy on a neutral canvas and keeps the same red
// accent family, so both themes read as one product rather than two designs.
private val ClawLightColors =
  ClawColors(
    canvas = Color(0xFFF7F7F9),
    surface = Color(0xFFFFFFFF),
    surfaceRaised = Color(0xFFFFFFFF),
    surfacePressed = Color(0xFFEFEFF3),
    accent = Color(0xFFC23434),
    accentSoft = Color(0x1AC23434),
    accentBorder = Color(0xFFA32C2C),
    border = Color(0xFFE4E4EA),
    borderStrong = Color(0xFFCFCFD8),
    text = Color(0xFF101014),
    textMuted = Color(0xFF52525B),
    textSubtle = Color(0xFF787885),
    primary = Color(0xFFC23434),
    primaryText = Color(0xFFFFFFFF),
    secondary = Color(0xFF0F8F81),
    success = Color(0xFF15803D),
    successSoft = Color(0x2215803D),
    warning = Color(0xFFB45309),
    warningSoft = Color(0x22B45309),
    danger = Color(0xFFB91C1C),
    dangerSoft = Color(0x22B91C1C),
    codeBg = Color(0xFFF1F1F4),
    codeText = Color(0xFF101014),
    codeBorder = Color(0xFFE4E4EA),
  )

internal fun clawColorsForTheme(
  dark: Boolean,
  accentArgb: Long?,
): ClawColors {
  val base = if (dark) ClawDarkColors else ClawLightColors
  val accent = accentArgb?.let(::Color) ?: return base
  return base.copy(
    accent = accent,
    accentSoft = accent.copy(alpha = if (dark) 0.25f else 0.08f).compositeOver(base.canvas),
    accentBorder = lerp(accent, Color.Black, 0.12f),
  )
}

private val LocalClawColors = staticCompositionLocalOf { ClawDarkColors }
private val LocalClawSpacing = staticCompositionLocalOf { ClawSpacing() }
private val LocalClawRadii = staticCompositionLocalOf { ClawRadii() }
private val LocalClawTypography = staticCompositionLocalOf { clawTypography(clawFontFamily) }

/**
 * Composition-local access point for OpenClaw Android design tokens.
 */
internal object ClawTheme {
  val colors: ClawColors
    @Composable
    @ReadOnlyComposable
    get() = LocalClawColors.current

  val spacing: ClawSpacing
    @Composable
    @ReadOnlyComposable
    get() = LocalClawSpacing.current

  val radii: ClawRadii
    @Composable
    @ReadOnlyComposable
    get() = LocalClawRadii.current

  val type: ClawTypography
    @Composable
    @ReadOnlyComposable
    get() = LocalClawTypography.current
}

/**
 * Installs OpenClaw design tokens and maps them into MaterialTheme for Material3 controls.
 */
@Composable
internal fun ClawDesignTheme(
  dark: Boolean = true,
  accentArgb: Long? = null,
  content: @Composable () -> Unit,
) {
  val colors = clawColorsForTheme(dark = dark, accentArgb = accentArgb)
  val typography = clawTypography(clawFontFamily)

  val spacing = ClawSpacing()

  CompositionLocalProvider(
    LocalClawColors provides colors,
    LocalClawSpacing provides spacing,
    LocalClawRadii provides ClawRadii(),
    LocalClawTypography provides typography,
    // Keep Material controls on the same accessibility floor as Claw controls while
    // their smaller painted geometry stays independent from the hit area.
    LocalMinimumInteractiveComponentSize provides spacing.touchTarget,
  ) {
    MaterialTheme(
      colorScheme = clawMaterialColorScheme(colors, dark),
      typography = materialTypography(typography),
      shapes = Shapes(),
      content = content,
    )
  }
}

private fun clawTypography(fontFamily: FontFamily) =
  ClawTypography(
    display =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.Bold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
        letterSpacing = 0.sp,
      ),
    title =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 17.sp,
        lineHeight = 22.sp,
        letterSpacing = 0.sp,
      ),
    section =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.sp,
      ),
    body =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 19.sp,
        letterSpacing = 0.sp,
      ),
    label =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.sp,
      ),
    caption =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.sp,
      ),
    captionSmall =
      TextStyle(
        fontFamily = fontFamily,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 14.sp,
        letterSpacing = 0.4.sp,
      ),
    mono =
      TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.sp,
      ),
  )

private fun materialTypography(type: ClawTypography) =
  Typography(
    displayMedium = type.display,
    titleLarge = type.title,
    titleMedium = type.section,
    bodyLarge = type.body,
    labelLarge = type.label,
    labelSmall = type.caption,
  )

private fun clawMaterialColorScheme(
  colors: ClawColors,
  dark: Boolean,
) = if (dark) {
  darkColorScheme(
    primary = colors.primary,
    onPrimary = colors.primaryText,
    primaryContainer = colors.accentSoft,
    onPrimaryContainer = colors.accent,
    secondary = colors.secondary,
    onSecondary = colors.canvas,
    // Material paints navigation and drawer selection from the secondary container.
    // Tinting it with the accent keeps every selected state on brand instead of
    // falling back to the stock Material purple.
    secondaryContainer = colors.accentSoft,
    onSecondaryContainer = colors.accent,
    background = colors.canvas,
    onBackground = colors.text,
    surface = colors.surface,
    onSurface = colors.text,
    surfaceVariant = colors.surfaceRaised,
    onSurfaceVariant = colors.textMuted,
    surfaceContainerLowest = colors.canvas,
    surfaceContainerLow = colors.surface,
    surfaceContainer = colors.surface,
    surfaceContainerHigh = colors.surfaceRaised,
    surfaceContainerHighest = colors.surfacePressed,
    outline = colors.borderStrong,
    outlineVariant = colors.border,
    scrim = Color(0xCC05070B),
    error = colors.danger,
    onError = colors.primaryText,
  )
} else {
  lightColorScheme(
    primary = colors.primary,
    onPrimary = colors.primaryText,
    primaryContainer = colors.accentSoft,
    onPrimaryContainer = colors.accent,
    secondary = colors.secondary,
    onSecondary = colors.primaryText,
    secondaryContainer = colors.accentSoft,
    onSecondaryContainer = colors.accent,
    background = colors.canvas,
    onBackground = colors.text,
    surface = colors.surface,
    onSurface = colors.text,
    surfaceVariant = colors.surfaceRaised,
    onSurfaceVariant = colors.textMuted,
    surfaceContainerLowest = colors.surface,
    surfaceContainerLow = colors.surface,
    surfaceContainer = colors.canvas,
    surfaceContainerHigh = colors.surfacePressed,
    surfaceContainerHighest = colors.surfacePressed,
    outline = colors.borderStrong,
    outlineVariant = colors.border,
    scrim = Color(0x99101014),
    error = colors.danger,
    onError = colors.primaryText,
  )
}
