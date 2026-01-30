### Agent Settings

{% if bindings.length %}
**Adapter bindings:**
{% for b in bindings %}
- {{ b.adapterType }} (bound)
{% endfor %}
{% else %}
**Adapter bindings:** (none)
{% endif %}
