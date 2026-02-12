{% if envelope.inReplyTo %}
{% if envelope.inReplyTo.fromName %}
in-reply-to-from-name: {{ envelope.inReplyTo.fromName }}
{% endif %}
in-reply-to-text:
{{ envelope.inReplyTo.text }}
{% endif %}
