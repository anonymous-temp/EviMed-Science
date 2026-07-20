package com.sentum.evidencecomprehensive.service;

import com.sentum.evidencecomprehensive.domain.vo.ws.WSBaseResp;
import io.netty.channel.Channel;

/**
 * @Description: websocket交互接口类
 */
public interface WebSocketService {

    void connect(Channel channel);

    void authorize(Channel channel, String token);

    void sendToUid(WSBaseResp<?> wsBaseResp, Long uid);
}
