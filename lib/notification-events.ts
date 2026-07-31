export type NotificationLevel = "info" | "success" | "warning" | "error"

export type NotificationParamValue = string | number

export const TRANSLATED_NOTIFICATION_EVENTS = {
  S3: { extraction_blocked_on_unverified_spikes: [] },
  S6: { extraction_extraction_blocked: [] },
  S8: { issue_parked_on_cr: ["id"] },
  S9: { gate_failed: ["id"], issue_blocked: ["id"] },
  S10: { merge_conflict_unresolved: ["id"], post_merge_gate_failed: ["id"] },
  crs: { approved_apply_blocked: ["id", "summary"], decide_error: ["id", "reason"] },
  cycle: { cycle_error: ["reason"] },
  extract: { error: ["reason"], refused_empty_canonical: ["reason"] },
  prepare: { failed: ["reason"] },
  retry: { retry_error: ["stage", "reason"] },
  skills: { failed: ["reason"], remove_failed: ["reason"] },
  vivi: {
    action_status_read_error: ["reason"],
    action_workflow_start_error: ["reason"],
    action_workflow_resume_error: ["reason"],
    action_workflow_stop_error: ["reason"],
    action_workflow_extract_error: ["reason"],
    action_workflow_retry_error: ["reason"],
    action_skills_install_error: ["reason"],
    action_skills_remove_error: ["reason"],
    action_map_move_error: ["reason"],
    action_crs_list_error: ["reason"],
    action_cycle_open_error: ["reason"],
    action_cycle_cancel_error: ["reason"],
    action_notifications_read_error: ["reason"],
    action_unknown_error: ["tool"],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>

export const UNTRANSLATED_NOTIFICATION_EVENTS = {
  S3: ["spike_change_request_drafted"],
  S9: ["quota_paused"],
  S10: ["checkpoint_commit_failed"],
  S12: ["run_finished", "run_blocked", "run_stalled", "run_max_relaunches"],
  SA: ["acceptance_findings", "acceptance_failed"],
  SK: ["heal_failed", "skills_failed", "skills_findings", "update_refused"],
  SP: ["language_unresolved", "doc_prep_failed", "doc_prep_findings"],
  SR: ["retro_proposals"],
  extract: ["blocked", "blocked_on_unverified_spikes", "failed"],
  import: ["secret_finding"],
  project: ["managed_files_failed"],
  retry: ["retry_extract_blocked"],
} as const satisfies Record<string, readonly string[]>

type Translated = typeof TRANSLATED_NOTIFICATION_EVENTS
type Untranslated = typeof UNTRANSLATED_NOTIFICATION_EVENTS

type ParamsOf<P> = P extends readonly [] ? never : P extends readonly (infer K extends string)[] ? Record<K, NotificationParamValue> : never

type Ref<S, E, P> = [ParamsOf<P>] extends [never] ? { stage: S; event: E; params?: undefined } : { stage: S; event: E; params: ParamsOf<P> }

export type NotificationRef =
  | {
      [S in keyof Translated]: { [E in keyof Translated[S]]: Ref<S, E, Translated[S][E]> }[keyof Translated[S]]
    }[keyof Translated]
  | {
      [S in keyof Untranslated]: { stage: S; event: Untranslated[S][number]; params?: undefined }
    }[keyof Untranslated]

export type NotificationInput = NotificationRef & { level: NotificationLevel; message: string }

// stage/event arrive off a disk line: `hasOwn`, never a bare index, or `constructor` resolves on the prototype.
export function translatedNotificationParams(stage: string, event: string): readonly string[] | null {
  const events: Record<string, readonly string[]> | undefined = Object.hasOwn(TRANSLATED_NOTIFICATION_EVENTS, stage)
    ? (TRANSLATED_NOTIFICATION_EVENTS as Record<string, Record<string, readonly string[]>>)[stage]
    : undefined
  if (!events || !Object.hasOwn(events, event)) return null
  return events[event]
}
