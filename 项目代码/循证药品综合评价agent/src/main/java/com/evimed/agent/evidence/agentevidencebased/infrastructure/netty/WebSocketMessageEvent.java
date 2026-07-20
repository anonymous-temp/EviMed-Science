package com.evimed.agent.evidence.agentevidencebased.infrastructure.netty;

import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import io.netty.channel.Channel;
import lombok.Getter;
import org.springframework.context.ApplicationEvent;

import java.util.ArrayList;
import java.util.List;

/**
 * WebSocket 消息事件
 * 封装从上游 WebSocket 服务接收到的消息，通过 Spring 事件机制传递给业务层
 * 与 evidence-based-agent 的同名文件保持一致
 */
@Getter
public class WebSocketMessageEvent extends ApplicationEvent {

    /** 会话ID（来自消息的 senderId，用于区分不同用户） */
    private final String channelId;

    /** 消息类型（text / clear / terminate 等） */
    private final String type;

    /** 消息内容（JSON字符串） */
    private final String content;

    /** 关联的 Netty Channel */
    private final Channel channel;

    /** Condition ID（可选，用于知识库检索等） */
    private final String conditionId;

    /** 完整的原始消息上下文（包含路由信息：id, parentId, userId 等） */
    private final JSONObject messageContext;

    /** 附件列表 */
    private final List<FileAttachment> attachments;

    public WebSocketMessageEvent(Object source, String channelId, String type, String content,
                                  Channel channel, String conditionId) {
        super(source);
        this.channelId = channelId;
        this.type = type;
        this.content = content;
        this.channel = channel;
        this.conditionId = conditionId;
        this.messageContext = null;
        this.attachments = new ArrayList<>();
    }

    public WebSocketMessageEvent(Object source, String channelId, String type, String content,
                                  Channel channel, String conditionId, JSONObject messageContext) {
        super(source);
        this.channelId = channelId;
        this.type = type;
        this.content = content;
        this.channel = channel;
        this.conditionId = conditionId;
        this.messageContext = messageContext;

        this.attachments = new ArrayList<>();
        if (messageContext != null && messageContext.containsKey("attachments")) {
            JSONArray attachmentsArray = messageContext.getJSONArray("attachments");
            if (attachmentsArray != null) {
                for (int i = 0; i < attachmentsArray.size(); i++) {
                    JSONObject attachJson = attachmentsArray.getJSONObject(i);
                    attachments.add(new FileAttachment(
                            attachJson.getString("fileId"),
                            attachJson.getString("fileName"),
                            attachJson.getString("fileType"),
                            attachJson.getLong("fileSize")
                    ));
                }
            }
        }
    }

    @Getter
    public static class FileAttachment {
        private final String fileId;
        private final String fileName;
        private final String fileType;
        private final Long fileSize;

        public FileAttachment(String fileId, String fileName, String fileType, Long fileSize) {
            this.fileId = fileId;
            this.fileName = fileName;
            this.fileType = fileType;
            this.fileSize = fileSize;
        }
    }
}
