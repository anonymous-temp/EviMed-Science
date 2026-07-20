package com.sentum.evidencecomprehensive.infrastructure.config;

import org.apache.http.HttpHost;
import org.apache.http.auth.AuthScope;
import org.apache.http.auth.UsernamePasswordCredentials;
import org.apache.http.client.CredentialsProvider;
import org.apache.http.impl.client.BasicCredentialsProvider;
import org.elasticsearch.client.RestClient;
import org.elasticsearch.client.RestClientBuilder;
import org.elasticsearch.client.RestHighLevelClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.elasticsearch.client.ClientConfiguration;
import org.springframework.data.elasticsearch.client.RestClients;
import org.springframework.data.elasticsearch.config.AbstractElasticsearchConfiguration;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;

import java.net.URI;
import java.time.Duration;

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

            // 自定义RestClientBuilder
            RestClientBuilder builder = RestClient.builder(httpHosts)
                    .setRequestConfigCallback(requestConfigBuilder -> {
                        requestConfigBuilder.setConnectTimeout(connectionTimeout.intValue())
                                .setSocketTimeout(socketTimeout.intValue())
                                .setConnectionRequestTimeout(60000); // 连接请求超时
                        return requestConfigBuilder;
                    })
                    .setHttpClientConfigCallback(httpClientBuilder -> {
                        httpClientBuilder.setMaxConnTotal(maxConnections)
                                .setMaxConnPerRoute(maxConnectionsPerRoute);
                        return httpClientBuilder;
                    });

            // 认证配置
            if (username != null && password != null && !username.isEmpty() && !password.isEmpty()) {
                final CredentialsProvider credentialsProvider = new BasicCredentialsProvider();
                credentialsProvider.setCredentials(AuthScope.ANY,
                        new UsernamePasswordCredentials(username, password));

                builder.setHttpClientConfigCallback(httpClientBuilder ->
                        httpClientBuilder
                                .setDefaultCredentialsProvider(credentialsProvider)
                                .setMaxConnTotal(maxConnections)
                                .setMaxConnPerRoute(maxConnectionsPerRoute)
                );
            }

            return new RestHighLevelClient(builder);

        } catch (Exception e) {
            throw new RuntimeException("❌ Failed to create Elasticsearch client: " + e.getMessage(), e);
        }
    }

    @Bean
    public ElasticsearchRestTemplate elasticsearchRestTemplate(RestHighLevelClient restHighLevelClient) {
        return new ElasticsearchRestTemplate(restHighLevelClient);
    }
}