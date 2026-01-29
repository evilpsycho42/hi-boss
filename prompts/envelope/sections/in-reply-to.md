{% if envelope.inReplyTo %}
in-reply-to-message-id: {{ envelope.inReplyTo.messageId }}
{% if envelope.inReplyTo.fromName %}
in-reply-to-from-name: {{ envelope.inReplyTo.fromName }}
{% endif %}
in-reply-to-text:
{{ envelope.inReplyTo.text }}
{% endif %}

