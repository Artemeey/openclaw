package ai.openclaw.app.ui

import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun sidebarSearchLabel(): String = nativeString("Search sessions")

@Composable
internal fun SidebarSearchField(
  query: String,
  onQueryChange: (String) -> Unit,
  palette: SidebarPalette,
  modifier: Modifier = Modifier,
) {
  val label = sidebarSearchLabel()
  val interactionSource = remember { MutableInteractionSource() }
  val focused by interactionSource.collectIsFocusedAsState()
  BasicTextField(
    value = query,
    onValueChange = onQueryChange,
    interactionSource = interactionSource,
    singleLine = true,
    textStyle = ClawTheme.type.body.copy(color = palette.text),
    cursorBrush = SolidColor(ClawTheme.colors.accent),
    modifier =
      modifier
        .fillMaxWidth()
        .heightIn(min = ClawTheme.spacing.touchTarget)
        .clip(RoundedCornerShape(ClawTheme.radii.control))
        .background(palette.elevated)
        .border(
          width = 1.dp,
          color = if (focused) ClawTheme.colors.accent else palette.hairline,
          shape = RoundedCornerShape(ClawTheme.radii.control),
        ).padding(start = 10.dp)
        .semantics { contentDescription = label }
        .testTag("sidebar-search"),
    decorationBox = { innerTextField ->
      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxs),
      ) {
        Icon(
          imageVector = Icons.Default.Search,
          contentDescription = null,
          modifier = Modifier.size(ClawTheme.spacing.icon),
          tint = palette.muted,
        )
        // The clear target carries its own trailing gutter; without it the value needs
        // one so text never runs into the field border.
        Box(modifier = Modifier.weight(1f).padding(end = if (query.isEmpty()) 10.dp else 0.dp)) {
          if (query.isEmpty()) {
            Text(text = label, style = ClawTheme.type.body, color = palette.muted, maxLines = 1)
          }
          innerTextField()
        }
        if (query.isNotEmpty()) {
          Box(
            modifier =
              Modifier
                .size(ClawTheme.spacing.touchTarget)
                .clip(CircleShape)
                .clickable(role = Role.Button) { onQueryChange("") },
            contentAlignment = Alignment.Center,
          ) {
            Icon(
              imageVector = Icons.Default.Close,
              contentDescription = nativeString("Clear session search"),
              modifier = Modifier.size(ClawTheme.spacing.icon),
              tint = palette.muted,
            )
          }
        }
      }
    },
  )
}

@Composable
internal fun SidebarSectionTitle(
  label: String,
  palette: SidebarPalette,
  modifier: Modifier = Modifier,
) {
  Text(
    text = label,
    style = ClawTheme.type.captionSmall.copy(fontWeight = FontWeight.SemiBold),
    color = palette.muted,
    modifier = modifier.semantics { heading() }.padding(horizontal = 10.dp, vertical = ClawTheme.spacing.xxxs),
    maxLines = 1,
  )
}

@Composable
internal fun SidebarActionRow(
  label: String,
  icon: ImageVector,
  palette: SidebarPalette,
  onClick: () -> Unit,
) {
  SidebarRowSurface(selected = null, palette = palette, onClick = onClick) {
    Spacer(modifier = Modifier.size(ClawTheme.spacing.icon))
    Text(
      text = label,
      style = ClawTheme.type.body,
      color = palette.muted,
      modifier = Modifier.weight(1f),
      maxLines = 1,
    )
    Icon(imageVector = icon, contentDescription = null, tint = palette.muted, modifier = Modifier.size(ClawTheme.spacing.icon))
  }
}

@Composable
internal fun SidebarNavigationRow(
  destination: SidebarDestination,
  selected: Boolean,
  palette: SidebarPalette,
  onClick: () -> Unit,
) {
  // Destinations and sessions share one row shape so the drawer reads as a single
  // list instead of two stacks with different insets and heights.
  SidebarRowSurface(selected = selected, palette = palette, onClick = onClick) {
    Icon(
      imageVector = destination.icon,
      contentDescription = null,
      modifier = Modifier.size(ClawTheme.spacing.icon),
      tint = if (selected) ClawTheme.colors.accent else palette.muted,
    )
    Text(
      text = destination.localizedLabel(),
      style = ClawTheme.type.body,
      color = if (selected) ClawTheme.colors.accent else palette.text,
      modifier = Modifier.weight(1f),
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
internal fun SidebarSessionRow(
  session: ChatSessionEntry,
  mainSessionKey: String,
  selected: Boolean,
  palette: SidebarPalette,
  onClick: () -> Unit,
) {
  val sessionStateDescription =
    when {
      session.status == "queued" -> nativeString("Queued")
      session.hasActiveRun == true -> nativeString("Working")
      session.unread == true -> nativeString("Needs attention")
      selected -> nativeString("Selected")
      else -> null
    }
  SidebarRowSurface(
    selected = selected,
    stateDescription = sessionStateDescription,
    palette = palette,
    onClick = onClick,
  ) {
    Box(
      modifier =
        Modifier
          .size(6.dp)
          .clip(CircleShape)
          .background(
            when {
              session.hasActiveRun == true -> ClawTheme.colors.warning
              session.unread == true -> ClawTheme.colors.accent
              else -> palette.muted.copy(alpha = 0.45f)
            },
          ).clearAndSetSemantics {},
    )
    Column(modifier = Modifier.weight(1f)) {
      Text(
        text = sidebarSessionTitle(session, mainSessionKey),
        style = ClawTheme.type.body,
        color = if (selected) ClawTheme.colors.accent else palette.text,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Text(
        text = sidebarSessionSubtitle(session, sessionStateDescription),
        style = ClawTheme.type.captionSmall,
        color = palette.muted,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    if (session.pinned == true) {
      Icon(
        imageVector = Icons.Default.PushPin,
        contentDescription = nativeString("Pinned"),
        modifier = Modifier.size(14.dp),
        tint = palette.muted,
      )
    }
  }
}

@Composable
private fun SidebarRowSurface(
  selected: Boolean?,
  stateDescription: String? = null,
  palette: SidebarPalette,
  onClick: () -> Unit,
  content: @Composable RowScope.() -> Unit,
) {
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .heightIn(min = ClawTheme.spacing.touchTarget)
        .clip(RoundedCornerShape(ClawTheme.radii.control))
        .background(if (selected == true) palette.selection else Color.Transparent)
        .then(
          if (selected == null) {
            Modifier.clickable(role = Role.Button, onClick = onClick)
          } else {
            Modifier.selectable(selected = selected, role = Role.Button, onClick = onClick)
          },
        ).then(
          if (stateDescription == null) {
            Modifier
          } else {
            Modifier.semantics { this.stateDescription = stateDescription }
          },
        ).padding(horizontal = 10.dp, vertical = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxs),
    content = content,
  )
}

internal fun sidebarSessionSubtitle(
  session: ChatSessionEntry,
  activeRunLabel: String?,
  nowMs: Long = System.currentTimeMillis(),
): String =
  sessionListSubtitle(
    session = session,
    fallback =
      if (session.hasActiveRun == true) checkNotNull(activeRunLabel) else sessionSourceLabel(session.key),
    nowMs = nowMs,
  )
