{% if envelope.isGroup %}
{{ envelope.authorLine }} at {{ envelope.createdAt.localIso }}:
{{ envelope.content.text }}
{% if envelope.content.attachmentsText != "(none)" %}
attachments:
{{ envelope.content.attachmentsText }}
{% endif %}
{% else %}
text:
{{ envelope.content.text }}
{% endif %}
