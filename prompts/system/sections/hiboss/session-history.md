### Recent session history

Recent session summaries from the last {{ internalSpace.sessionSummariesRecentDays }} day(s) are shown below. To review full conversation details, read the corresponding file at `internal_space/history/YYYY-MM-DD/<session-id>.json`.
{% if internalSpace.sessionSummariesError %}

session-history-unavailable: {{ internalSpace.sessionSummariesError }}
{% elif internalSpace.sessionSummaries %}

{{ internalSpace.sessionSummaries }}
{% else %}

(no recent session summaries found)
{% endif %}
