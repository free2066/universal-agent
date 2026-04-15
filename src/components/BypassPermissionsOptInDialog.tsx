import React from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { Box, Link, Text } from '../ink.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

// NOTE: This copy is legally reviewed — do not modify without Legal team approval.
export const BYPASS_PERMISSIONS_DESCRIPTION = "Bypass permissions mode disables all permission prompts — Claude executes all tool calls without confirmation. Ideal for long-running tasks in isolated environments. Claude can execute harmful commands, it's strongly recommended to only use in sandboxed containers. Shift+Tab to change mode."

type Props = {
  onAccept(): void
  onDecline(): void
  // Startup gate: decline exits the process, so relabel accordingly.
  declineExits?: boolean
}

export function BypassPermissionsOptInDialog({
  onAccept,
  onDecline,
  declineExits,
}: Props): React.ReactElement {
  React.useEffect(() => {
    logEvent('tengu_bypass_permissions_opt_in_dialog_shown', {})
  }, [])

  function onChange(value: 'accept' | 'accept-default' | 'decline') {
    switch (value) {
      case 'accept': {
        logEvent('tengu_bypass_permissions_opt_in_dialog_accept', {})
        updateSettingsForSource('userSettings', {
          skipBypassPermissionsPrompt: true,
        })
        onAccept()
        break
      }
      case 'accept-default': {
        logEvent('tengu_bypass_permissions_opt_in_dialog_accept_default', {})
        updateSettingsForSource('userSettings', {
          skipBypassPermissionsPrompt: true,
          permissions: { defaultMode: 'bypassPermissions' },
        })
        onAccept()
        break
      }
      case 'decline': {
        logEvent('tengu_bypass_permissions_opt_in_dialog_decline', {})
        onDecline()
      }
    }
  }

  return (
    <Dialog
      title="Enable bypass permissions mode?"
      color="warning"
      onCancel={onDecline}
    >
      <Box flexDirection="column" gap={1}>
        <Text>{BYPASS_PERMISSIONS_DESCRIPTION}</Text>
        <Link url="https://code.claude.com/docs/en/security" />
      </Box>

      <Select
        options={[
          {
            label: 'Yes, and make it my default mode',
            value: 'accept-default' as const,
          },
          {
            label: 'Yes, enable bypass permissions',
            value: 'accept' as const,
          },
          {
            label: declineExits ? 'No, exit' : 'No, go back',
            value: 'decline' as const,
          },
        ]}
        onChange={(value) =>
          onChange(value as 'accept' | 'accept-default' | 'decline')
        }
        onCancel={onDecline}
      />
    </Dialog>
  )
}
