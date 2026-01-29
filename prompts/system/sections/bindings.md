## Bindings

{% if bindings.length %}
{% for b in bindings %}
- {{ b.adapterType }} (bound)
{% endfor %}
{% else %}
(none)
{% endif %}

