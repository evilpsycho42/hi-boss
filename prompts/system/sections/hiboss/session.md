### Session Management

{% if agent.sessionPolicy.dailyResetAt or agent.sessionPolicy.idleTimeout or agent.sessionPolicy.maxContextLength %}
Your session resets under these conditions:
{% if agent.sessionPolicy.dailyResetAt %}- Daily at {{ agent.sessionPolicy.dailyResetAt }}
{% endif %}{% if agent.sessionPolicy.idleTimeout %}- After {{ agent.sessionPolicy.idleTimeout }} of inactivity
{% endif %}{% if agent.sessionPolicy.maxContextLength %}- After context length exceeds {{ agent.sessionPolicy.maxContextLength }} tokens
{% endif %}
When session resets, conversation history clears but memory files persist.
{% else %}
No session reset policy configured.
{% endif %}
