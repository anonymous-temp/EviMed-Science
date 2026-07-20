package com.evimed.agent.evidence.agentevidencebased.infrastructure.netty;

import cn.hutool.http.HttpUtil;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import io.netty.bootstrap.Bootstrap;
import io.netty.channel.*;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioSocketChannel;
import io.netty.handler.codec.http.DefaultHttpHeaders;
import io.netty.handler.codec.http.FullHttpResponse;
import io.netty.handler.codec.http.HttpClientCodec;
import io.netty.handler.codec.http.HttpObjectAggregator;
import io.netty.handler.codec.http.websocketx.*;
import io.netty.handler.codec.http.websocketx.extensions.compression.WebSocketClientCompressionHandler;
import io.netty.handler.logging.LogLevel;
import io.netty.handler.logging.LoggingHandler;
import io.netty.handler.ssl.SslHandler;
import io.netty.handler.timeout.IdleState;
import io.netty.handler.timeout.IdleStateEvent;
import io.netty.handler.timeout.IdleStateHandler;
import io.netty.util.concurrent.DefaultEventExecutorGroup;
import io.netty.util.concurrent.EventExecutorGroup;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Component;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import java.net.URI;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Netty WebSocket 客户端
 * 连接上游消息服务器，接收用户消息并回传 Agent 响应
 * 与 evidence-based-agent 的 NettyWebSocketClient 保持一致
 */
@Slf4j
@Component
public class NettyWebSocketClient {

    private final ApplicationEventPublisher eventPublisher;
    private final RedisTemplate<String, Object> redisTemplate;

    @Value("${upstream.wesocket.url}")
    private String webSocketUrl;

    @Value("${upstream.wesocket.api}")
    private String authTokenUrl;

    @Value("${upstream.wesocket.client-type}")
    private String clientType;

    @Value("${upstream.wesocket.enabled}")
    private boolean enabled;

    // Token Redis Key（使用 clientType 动态构造，避免与其他客户端冲突）
    private String tokenKey;

    private EventLoopGroup group;
    private Channel channel;
    private final AtomicBoolean isConnected = new AtomicBoolean(false);
    private EventExecutorGroup heartbeatExecutor;

    private static final String HEARTBEAT_MESSAGE;

    static {
        JSONObject heartJson = new JSONObject();
        heartJson.put("type", "heartbeat");
        HEARTBEAT_MESSAGE = heartJson.toJSONString();
    }

    public NettyWebSocketClient(ApplicationEventPublisher eventPublisher,
                                RedisTemplate<String, Object> redisTemplate) {
        this.eventPublisher = eventPublisher;
        this.redisTemplate = redisTemplate;
    }

    @PostConstruct
    public void start() {
        this.tokenKey = "netty:" + clientType;

        if (!enabled) {
            log.info("上游 WebSocket 客户端未启用 (upstream.wesocket.enabled=false)，跳过连接");
            return;
        }

        if (isConnected.get()) {
            log.warn("WebSocket 客户端已连接，无需重复启动");
            return;
        }

        new Thread(this::doConnect, "upstream-websocket-client").start();
    }

    private void doConnect() {
        group = new NioEventLoopGroup();
        heartbeatExecutor = new DefaultEventExecutorGroup(1);

        try {
            URI uri = new URI(webSocketUrl);
            String scheme = uri.getScheme() == null ? "ws" : uri.getScheme();
            final String host = uri.getHost() == null ? "127.0.0.1" : uri.getHost();
            final int port;
            if (uri.getPort() == -1) {
                port = "wss".equalsIgnoreCase(scheme) ? 443 : 80;
            } else {
                port = uri.getPort();
            }

            DefaultHttpHeaders customHeaders = new DefaultHttpHeaders();
            customHeaders.add("Origin", scheme + "://" + host);
            customHeaders.add("Host", host);
            customHeaders.add("User-Agent", "Netty-WebSocket-Client/1.0");

            final WebSocketClientHandshaker handshaker = WebSocketClientHandshakerFactory.newHandshaker(
                    uri, WebSocketVersion.V13, null, true, customHeaders);

            final boolean isSecure = "wss".equalsIgnoreCase(scheme);
            final SSLEngine finalSslEngine;
            if (isSecure) {
                SSLContext sslContext = SSLContext.getInstance("TLS");
                sslContext.init(null, new TrustManager[]{new X509TrustManager() {
                    @Override
                    public void checkServerTrusted(X509Certificate[] chain, String authType) {}
                    @Override
                    public void checkClientTrusted(X509Certificate[] x509Certificates, String s) throws CertificateException {}
                    @Override
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                }}, new SecureRandom());
                finalSslEngine = sslContext.createSSLEngine(host, port);
                finalSslEngine.setUseClientMode(true);
            } else {
                finalSslEngine = null;
            }

            Bootstrap b = new Bootstrap();
            b.group(group)
                    .channel(NioSocketChannel.class)
                    .option(ChannelOption.TCP_NODELAY, true)
                    .handler(new LoggingHandler(LogLevel.INFO))
                    .handler(new ChannelInitializer<SocketChannel>() {
                        @Override
                        protected void initChannel(SocketChannel ch) {
                            ChannelPipeline p = ch.pipeline();
                            if (finalSslEngine != null) {
                                p.addLast(new SslHandler(finalSslEngine));
                            }
                            p.addLast(new HttpClientCodec());
                            p.addLast(new HttpObjectAggregator(8192));
                            p.addLast(WebSocketClientCompressionHandler.INSTANCE);
                            p.addLast(new IdleStateHandler(0, 20, 0, TimeUnit.SECONDS));
                            p.addLast(new WebSocketClientHandler(handshaker));
                            p.addLast(heartbeatExecutor, new HeartbeatHandler());
                        }
                    });

            log.info("连接上游 WebSocket 服务: {}", webSocketUrl);
            ChannelFuture future = b.connect(host, port).sync();
            channel = future.channel();

            WebSocketClientHandler handler = channel.pipeline().get(WebSocketClientHandler.class);
            handler.handshakeFuture().sync();

            isConnected.set(true);
            log.info("WebSocket 客户端连接成功，clientType={}", clientType);

            channel.closeFuture().sync();
        } catch (Exception e) {
            log.error("WebSocket 客户端连接失败: {}", e.getMessage());
            isConnected.set(false);
        } finally {
            if (group != null) group.shutdownGracefully().syncUninterruptibly();
            if (heartbeatExecutor != null) heartbeatExecutor.shutdownGracefully().syncUninterruptibly();
            isConnected.set(false);
            log.info("WebSocket 客户端已关闭");

            // 断线重连
            if (enabled) {
                try {
                    TimeUnit.SECONDS.sleep(5);
                    doConnect();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }

    public void sendMessage(String message) {
        if (channel != null && channel.isActive()) {
            channel.writeAndFlush(new TextWebSocketFrame(message));
        } else {
            log.error("WebSocket 连接未建立，无法发送消息");
        }
    }

    public boolean isConnected() {
        return isConnected.get();
    }

    // ===== 内部 Handler =====

    private class WebSocketClientHandler extends SimpleChannelInboundHandler<Object> {
        private final WebSocketClientHandshaker handshaker;
        private ChannelPromise handshakeFuture;

        public WebSocketClientHandler(WebSocketClientHandshaker handshaker) {
            this.handshaker = handshaker;
        }

        public ChannelFuture handshakeFuture() {
            return handshakeFuture;
        }

        @Override
        public void handlerAdded(ChannelHandlerContext ctx) {
            handshakeFuture = ctx.newPromise();
        }

        @Override
        public void channelActive(ChannelHandlerContext ctx) {
            handshaker.handshake(ctx.channel());
        }

        @Override
        public void channelInactive(ChannelHandlerContext ctx) {
            log.info("WebSocket 连接已断开");
            isConnected.set(false);
        }

        @Override
        protected void channelRead0(ChannelHandlerContext ctx, Object msg) {
            Channel ch = ctx.channel();

            if (!handshaker.isHandshakeComplete()) {
                try {
                    handshaker.finishHandshake(ch, (FullHttpResponse) msg);
                    log.info("WebSocket 握手完成");
                    handshakeFuture.setSuccess();
                    sendAuthMessage(ctx, "");
                } catch (WebSocketHandshakeException e) {
                    log.error("WebSocket 握手失败: {}", e.getMessage());
                    handshakeFuture.setFailure(e);
                }
                return;
            }

            if (msg instanceof FullHttpResponse response) {
                throw new IllegalStateException(
                        "Unexpected FullHttpResponse (status=" + response.status() + ")");
            }

            WebSocketFrame frame = (WebSocketFrame) msg;

            if (frame instanceof TextWebSocketFrame textFrame) {
                String messageStr = textFrame.text();
                log.debug("收到上游消息: {}", messageStr);

                try {
                    JSONObject message = JSON.parseObject(messageStr);
                    String type = message.getString("type");
                    String content = message.getString("content");

                    switch (type) {
                        case "server":
                            log.debug("收到服务端心跳回复");
                            break;
                        case "system":
                            if ("认证失败，无效的令牌".equals(content)) {
                                sendAuthMessage(ctx, "认证失败，无效的令牌");
                            }
                            break;
                        case "text":
                            String sessionId = message.getString("senderId");
                            if (sessionId == null || sessionId.isBlank()) {
                                sessionId = message.getString("targetClientId");
                            }
                            if (sessionId == null || sessionId.isBlank()) {
                                sessionId = message.getString("userId");
                            }
                            if (sessionId == null || sessionId.isBlank()) {
                                sessionId = ch.id().asShortText();
                                log.warn("消息缺少用户标识，降级使用 channelId: {}", sessionId);
                            }
                            WebSocketMessageEvent event = new WebSocketMessageEvent(
                                    this, sessionId, type, content, ch, null, message);
                            eventPublisher.publishEvent(event);
                            break;
                        default:
                            break;
                    }
                } catch (Exception e) {
                    log.error("处理上游消息失败", e);
                }
            } else if (frame instanceof PingWebSocketFrame pingFrame) {
                // RFC 6455: answer server pings, otherwise keepalive-enabled
                // upstreams drop the connection and in-flight messages are lost
                log.debug("收到上游 Ping,回复 Pong");
                ch.writeAndFlush(new PongWebSocketFrame(pingFrame.content().retain()));
            } else if (frame instanceof PongWebSocketFrame) {
                log.debug("收到上游 Pong 响应");
            } else if (frame instanceof CloseWebSocketFrame) {
                log.info("收到上游关闭连接请求");
                ch.close();
            }
        }

        @Override
        public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
            log.error("WebSocket 客户端异常", cause);
            if (!handshakeFuture.isDone()) {
                handshakeFuture.setFailure(cause);
            }
            ctx.close();
        }

        @Override
        public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
            ctx.fireUserEventTriggered(evt);
        }
    }

    private void sendAuthMessage(ChannelHandlerContext ctx, String info) {
        try {
            String token = getAuthToken(info);
            JSONObject authMessage = new JSONObject();
            authMessage.put("type", "auth");
            authMessage.put("clientType", clientType);
            authMessage.put("token", token);
            ctx.writeAndFlush(new TextWebSocketFrame(authMessage.toJSONString()));
            log.info("已发送认证消息，clientType={}", clientType);
        } catch (Exception e) {
            log.error("发送认证消息失败", e);
        }
    }

    private String getAuthToken(String info) {
        if (info.contains("无效的令牌")) {
            String s = HttpUtil.get(authTokenUrl + clientType);
            JSONObject resultJson = JSONObject.parseObject(s);
            String token = resultJson.getJSONObject("data").getString("token");
            redisTemplate.opsForValue().set(tokenKey, token, 24, TimeUnit.HOURS);
            return token;
        }
        Object cached = redisTemplate.opsForValue().get(tokenKey);
        if (cached != null) {
            return cached.toString();
        }
        String s = HttpUtil.get(authTokenUrl + clientType);
        JSONObject resultJson = JSONObject.parseObject(s);
        String token = resultJson.getJSONObject("data").getString("token");
        redisTemplate.opsForValue().set(tokenKey, token, 24, TimeUnit.HOURS);
        return token;
    }

    private static class HeartbeatHandler extends ChannelInboundHandlerAdapter {
        @Override
        public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
            if (evt instanceof IdleStateEvent idleEvent) {
                if (idleEvent.state() == IdleState.WRITER_IDLE) {
                    if (ctx.channel().isActive() && ctx.channel().isWritable()) {
                        ctx.writeAndFlush(new PingWebSocketFrame())
                                .addListener(future -> {
                                    if (!future.isSuccess()) {
                                        log.error("心跳发送失败", future.cause());
                                        ctx.channel().close();
                                    }
                                });
                    }
                }
            } else {
                super.userEventTriggered(ctx, evt);
            }
        }
    }
}
