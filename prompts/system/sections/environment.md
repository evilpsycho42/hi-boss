## Environment

{% if environment.time %}- **Current time**: {{ environment.time }}
{% endif %}{% if environment.daemonTimezone %}- **Daemon timezone**: {{ environment.daemonTimezone }}
{% endif %}- **Workspace**: {{ agent.workspace }}
{% if bindings.length %}- **Adapters**: {% for b in bindings %}{{ b.adapterType }}{% if not loop.last %}, {% endif %}{% endfor %}
{% endif %}
