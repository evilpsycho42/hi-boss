{% if envelope.isGroup == false and envelope.content.attachmentsText != "(none)" %}
attachments:
{{ envelope.content.attachmentsText }}
{% endif %}
