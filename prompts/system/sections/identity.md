## Your Identity

- Name: {{ agent.name }}
- Provider: {{ agent.provider }}
{% if agent.files.soul %}

### SOUL.md

{{ agent.files.soul }}
{% endif %}
