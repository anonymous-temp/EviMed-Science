package com.sentum.infrastructure.config;

import org.apache.http.HttpHost;
import org.apache.http.auth.AuthScope;
import org.apache.http.auth.UsernamePasswordCredentials;
import org.apache.http.client.CredentialsProvider;
import org.apache.http.config.Registry;
import org.apache.http.config.RegistryBuilder;
import org.apache.http.impl.client.BasicCredentialsProvider;
import org.apache.http.impl.nio.conn.PoolingNHttpClientConnectionManager;
import org.apache.http.impl.nio.reactor.DefaultConnectingIOReactor;
import org.apache.http.impl.nio.reactor.IOReactorConfig;
import org.apache.http.nio.conn.NoopIOSessionStrategy;
import org.apache.http.nio.conn.SchemeIOSessionStrategy;
import org.apache.http.nio.conn.ssl.SSLIOSessionStrategy;
import org.apache.http.nio.reactor.IOReactorException;
import org.elasticsearch.client.RestClient;
import org.elasticsearch.client.RestClientBuilder;
import org.elasticsearch.client.RestHighLevelClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;

import java.net.URI;
import java.util.concurrent.TimeUnit;

@Configuration
public class RestClientConfig {

    @Value("${spring.elasticsearch.rest.uris}")
    private String uris;
    @Value("${spring.elasticsearch.rest.username}")
    private String username;
    @Value("${spring.elasticsearch.rest.password}")
    private String password;
    @Value("${spring.elasticsearch.rest.connection-timeout:10000}")
    private Long connectionTimeout;
    @Value("${spring.elasticsearch.rest.read-timeout:60000}")
    private Long socketTimeout;
    @Value("${spring.elasticsearch.rest.max-connections:100}")
    private Integer maxConnections;
    @Value("${spring.elasticsearch.rest.max-connections-per-route:100}")
    private Integer maxConnectionsPerRoute;

    @Bean
    public RestHighLevelClient elasticsearchClient() {
        try {
            String[] uriArray = uris.split(",");

            // 手动构建HttpHost数组
            HttpHost[] httpHosts = new HttpHost[uriArray.length];
            for (int i = 0; i < uriArray.length; i++) {
                URI uri = new URI(uriArray[i].trim());
                httpHosts[i] = new HttpHost(uri.getHost(), uri.getPort(), uri.getScheme());
            }

            // 认证配置
            final CredentialsProvider credentialsProvider = new BasicCredentialsProvider();
            if (username != null && password != null && !username.isEmpty() && !password.isEmpty()) {
                credentialsProvider.setCredentials(AuthScope.ANY,
                        new UsernamePasswordCredentials(username, password));
            }

            // 自定义RestClientBuilder
            RestClientBuilder builder = RestClient.builder(httpHosts)
                    .setRequestConfigCallback(requestConfigBuilder -> {
                        requestConfigBuilder.setConnectTimeout(connectionTimeout.intValue())
                                .setSocketTimeout(socketTimeout.intValue())
                                .setConnectionRequestTimeout(60000);
                        return requestConfigBuilder;
                    })
                    .setHttpClientConfigCallback(httpClientBuilder -> {
                        try {
                            // 配置 IO Reactor，设置连接和读取超时
                            IOReactorConfig ioReactorConfig = IOReactorConfig.custom()
                                    .setConnectTimeout(connectionTimeout.intValue())
                                    .setSoTimeout(socketTimeout.intValue())
                                    .build();

                            // 显式构建协议注册表，httpasyncclient-4.1.4 的 TTL 构造方法
                            // 第三个参数是 Registry<SchemeIOSessionStrategy>，不能传 null
                            Registry<SchemeIOSessionStrategy> sessionStrategyRegistry =
                                    RegistryBuilder.<SchemeIOSessionStrategy>create()
                                            .register("http", NoopIOSessionStrategy.INSTANCE)
                                            .register("https", SSLIOSessionStrategy.getDefaultStrategy())
                                            .build();

                            // 使用带 TTL 的连接管理器：连接最长存活 25s，短于阿里云SLB的空闲超时(60-90s)
                            // 这样可以在连接被服务端关闭之前主动丢弃，避免出现僵尸连接导致首次请求卡住
                            PoolingNHttpClientConnectionManager connManager =
                                    new PoolingNHttpClientConnectionManager(
                                            new DefaultConnectingIOReactor(ioReactorConfig),
                                            null,
                                            sessionStrategyRegistry,
                                            null,
                                            null,
                                            25L, TimeUnit.SECONDS
                                    );
                            connManager.setMaxTotal(maxConnections);
                            connManager.setDefaultMaxPerRoute(maxConnectionsPerRoute);

                            httpClientBuilder
                                    .setDefaultCredentialsProvider(credentialsProvider)
                                    .setConnectionManager(connManager);
                        } catch (IOReactorException e) {
                            throw new RuntimeException("ES connection manager init failed", e);
                        }
                        return httpClientBuilder;
                    });

            return new RestHighLevelClient(builder);

        } catch (Exception e) {
            throw new RuntimeException("Failed to create Elasticsearch client: " + e.getMessage(), e);
        }
    }

    @Bean
    public ElasticsearchRestTemplate elasticsearchRestTemplate(RestHighLevelClient restHighLevelClient) {
        return new ElasticsearchRestTemplate(restHighLevelClient);
    }
}
