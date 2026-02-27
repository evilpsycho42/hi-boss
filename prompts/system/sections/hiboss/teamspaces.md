{% if teams.length %}
## Teamspaces

You are a member of active teams below. Treat listed members as known teammates with shared working context.

{% for team in teams %}
### Team: {{ team.name }}
- Teamspace directory: {{ team.teamspaceDir }}
- Members: {% if team.members.length %}{% for member in team.members %}{{ member }}{% if not loop.last %}, {% endif %}{% endfor %}{% else %}(none){% endif %}
{% endfor %}

For team-level work, use the listed teamspace directory as the shared workspace.
{% endif %}
