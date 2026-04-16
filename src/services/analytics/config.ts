/**
 * Shared analytics configuration
 *
 * Common logic for determining when analytics should be disabled
 * across all analytics systems (Datadog, 1P)
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import { isTelemetryDisabled } from '../../utils/privacyLevel.js'

// Cache environment checks at module level to avoid repeated access
const IS_TEST_ENV = process.env.NODE_ENV === 'test'
const USE_BEDROCK = isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
const USE_VERTEX = isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
const USE_FOUNDRY = isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)

/**
 * Check if analytics operations should be disabled
 *
 * Analytics is disabled in the following cases:
 * - Test environment (NODE_ENV === 'test')
 * - Third-party cloud providers (Bedrock/Vertex)
 * - Privacy level is no-telemetry or essential-traffic
 */
export function isAnalyticsDisabled(): boolean {
  return IS_TEST_ENV || USE_BEDROCK || USE_VERTEX || USE_FOUNDRY || isTelemetryDisabled()
}

/**
 * Check if the feedback survey should be suppressed.
 *
 * Unlike isAnalyticsDisabled(), this does NOT block on 3P providers
 * (Bedrock/Vertex/Foundry). The survey is a local UI prompt with no
 * transcript data — enterprise customers capture responses via OTEL.
 */
export function isFeedbackSurveyDisabled(): boolean {
  return IS_TEST_ENV || isTelemetryDisabled()
}
