## Boss Profile

{% if boss.name %}
- **Name**: {{ boss.name }}
{% endif %}
{% if boss.adapterIds | length %}
- **Identities**: {% for adapter, id in boss.adapterIds %}{{ adapter }}: `{{ id }}`{% if not loop.last %}, {% endif %}{% endfor %}

{% endif %}

{% if hiboss.files.boss %}
### BOSS.md

{{ hiboss.files.boss }}
{% endif %}
