package ai.openclaw.app.ui

import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.DrawerState
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfoV2
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.window.core.layout.WindowSizeClass.Companion.HEIGHT_DP_MEDIUM_LOWER_BOUND
import androidx.window.core.layout.WindowSizeClass.Companion.WIDTH_DP_EXPANDED_LOWER_BOUND
import androidx.window.core.layout.WindowSizeClass.Companion.WIDTH_DP_MEDIUM_LOWER_BOUND

internal const val adaptiveMediumWidthLowerBoundDp = 600f
internal const val adaptiveExpandedWidthLowerBoundDp = 840f
internal const val adaptiveMediumHeightLowerBoundDp = 480f

internal enum class AdaptiveNavigationMode {
  Bar,
  Rail,
  Drawer,
}

internal fun adaptiveNavigationMode(
  availableWidthDp: Float,
  availableHeightDp: Float,
  tabletop: Boolean = false,
): AdaptiveNavigationMode =
  adaptiveNavigationMode(
    widthAtLeastMedium = availableWidthDp >= adaptiveMediumWidthLowerBoundDp,
    widthAtLeastExpanded = availableWidthDp >= adaptiveExpandedWidthLowerBoundDp,
    heightAtLeastMedium = availableHeightDp >= adaptiveMediumHeightLowerBoundDp,
    tabletop = tabletop,
  )

private fun adaptiveNavigationMode(
  widthAtLeastMedium: Boolean,
  widthAtLeastExpanded: Boolean,
  heightAtLeastMedium: Boolean,
  tabletop: Boolean,
): AdaptiveNavigationMode =
  when {
    tabletop || !widthAtLeastMedium || !heightAtLeastMedium ->
      AdaptiveNavigationMode.Bar
    !widthAtLeastExpanded -> AdaptiveNavigationMode.Rail
    else -> AdaptiveNavigationMode.Drawer
  }

private fun AdaptiveNavigationMode.toNavigationSuiteType(): NavigationSuiteType =
  when (this) {
    AdaptiveNavigationMode.Bar -> NavigationSuiteType.NavigationBar
    AdaptiveNavigationMode.Rail -> NavigationSuiteType.NavigationRail
    AdaptiveNavigationMode.Drawer -> NavigationSuiteType.NavigationDrawer
  }

internal fun adaptiveNavigationSuiteType(
  navigationMode: AdaptiveNavigationMode,
  compactNavigationVisible: Boolean,
): NavigationSuiteType =
  if (navigationMode == AdaptiveNavigationMode.Bar && !compactNavigationVisible) {
    NavigationSuiteType.None
  } else {
    navigationMode.toNavigationSuiteType()
  }

/**
 * Material-owned adaptive navigation for every top-level destination.
 *
 * The primary destinations stay in one [NavigationSuiteScaffold] content slot as
 * the window changes between bar, rail, and permanent drawer. Rich session and
 * agent controls live in a native modal drawer so Material owns edge gestures,
 * scrim dismissal, back handling, focus containment, and RTL behavior.
 */
@Composable
internal fun AdaptiveNavigationShell(
  drawerState: DrawerState,
  compactNavigationVisible: Boolean,
  activeDestination: SidebarDestination?,
  onSelectDestination: (SidebarDestination) -> Unit,
  drawerContent: @Composable () -> Unit,
  content: @Composable () -> Unit,
) {
  val adaptiveInfo = currentWindowAdaptiveInfoV2()
  val navigationMode =
    adaptiveNavigationMode(
      widthAtLeastMedium =
        adaptiveInfo.windowSizeClass.isWidthAtLeastBreakpoint(WIDTH_DP_MEDIUM_LOWER_BOUND),
      widthAtLeastExpanded =
        adaptiveInfo.windowSizeClass.isWidthAtLeastBreakpoint(WIDTH_DP_EXPANDED_LOWER_BOUND),
      heightAtLeastMedium =
        adaptiveInfo.windowSizeClass.isHeightAtLeastBreakpoint(HEIGHT_DP_MEDIUM_LOWER_BOUND),
      tabletop = adaptiveInfo.windowPosture.isTabletop,
    )
  val itemColors =
    NavigationSuiteDefaults.itemColors(
      navigationBarItemColors =
        NavigationBarItemDefaults.colors(
          selectedIconColor = ClawTheme.colors.accent,
          selectedTextColor = ClawTheme.colors.accent,
          indicatorColor = ClawTheme.colors.accentSoft,
          unselectedIconColor = ClawTheme.colors.textMuted,
          unselectedTextColor = ClawTheme.colors.textMuted,
        ),
      navigationRailItemColors =
        NavigationRailItemDefaults.colors(
          selectedIconColor = ClawTheme.colors.accent,
          selectedTextColor = ClawTheme.colors.accent,
          indicatorColor = ClawTheme.colors.accentSoft,
          unselectedIconColor = ClawTheme.colors.textMuted,
          unselectedTextColor = ClawTheme.colors.textMuted,
        ),
      navigationDrawerItemColors =
        NavigationDrawerItemDefaults.colors(
          selectedContainerColor = ClawTheme.colors.accentSoft,
          selectedIconColor = ClawTheme.colors.accent,
          selectedTextColor = ClawTheme.colors.accent,
          unselectedIconColor = ClawTheme.colors.textMuted,
          unselectedTextColor = ClawTheme.colors.textMuted,
        ),
    )

  ModalNavigationDrawer(
    drawerState = drawerState,
    gesturesEnabled = true,
    drawerContent = {
      ModalDrawerSheet(
        drawerState = drawerState,
        modifier = Modifier.widthIn(max = 360.dp).testTag("adaptive-secondary-drawer"),
        drawerContainerColor = ClawTheme.colors.surface,
        drawerContentColor = ClawTheme.colors.text,
      ) {
        drawerContent()
      }
    },
  ) {
    NavigationSuiteScaffold(
      navigationSuiteItems = {
        SidebarDestination.entries.forEach { destination ->
          val fullLabel = destination.localizedLabel()
          val displayLabel =
            if (navigationMode == AdaptiveNavigationMode.Bar) {
              destination.compactLocalizedLabel()
            } else {
              fullLabel
            }
          item(
            selected = destination == activeDestination,
            onClick = { onSelectDestination(destination) },
            // The label carries the accessible name in every layout, so a duplicate icon
            // description would make TalkBack announce each destination twice.
            icon = { Icon(imageVector = destination.icon, contentDescription = null) },
            label = {
              Text(
                text = displayLabel,
                modifier =
                  Modifier.clearAndSetSemantics {
                    contentDescription = fullLabel
                  },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
              )
            },
            // Icon-only compact destinations are unreadable, so every bar item keeps its
            // short label; the semantics above still announce the full destination name.
            alwaysShowLabel = true,
            colors = itemColors,
          )
        }
      },
      modifier = Modifier.fillMaxSize().testTag("adaptive-navigation-suite"),
      layoutType =
        adaptiveNavigationSuiteType(
          navigationMode = navigationMode,
          compactNavigationVisible = compactNavigationVisible,
        ),
      containerColor = ClawTheme.colors.canvas,
      contentColor = ClawTheme.colors.text,
      content = content,
    )
  }
}
