## Pending Envelopes ({{ envelopes | length }})

{% if envelopes | length == 0 %}
No pending envelopes.
{% else %}
{% for env in envelopes %}
{% set envelope = env %}
{% include "turn/sections/envelope.md" %}
{% if not loop.last %}

---

{% endif %}
{% endfor %}
{% endif %}

