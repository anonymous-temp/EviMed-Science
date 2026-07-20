package com.evimed.agent.evidence.agentevidencebased.infrastructure.config;

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

@Configuration
public class ElasticsearchConfig {

    @Value("${spring.elasticsearch.username}")
    private String username;

    @Value("${spring.elasticsearch.password}")
    private String password;

    @Value("${spring.elasticsearch.host:es-cn-8t84ft4ee0003tib9.public.elasticsearch.aliyuncs.com}")
    private String host;

    @Value("${spring.elasticsearch.port:9200}")
    private int port;

    @Bean(destroyMethod = "close")
    public RestHighLevelClient restHighLevelClient() {

        // 配置账号密码
        final CredentialsProvider credentialsProvider = new BasicCredentialsProvider();
        credentialsProvider.setCredentials(
                AuthScope.ANY,
                new UsernamePasswordCredentials(username, password)
        );

        // 解析 host URL
        String scheme = "http";
        String hostname = host;
        int actualPort = port;

        if (host.startsWith("http://") || host.startsWith("https://")) {
            scheme = host.startsWith("https://") ? "https" : "http";
            String urlPart = host.substring(scheme.length() + 3); // 去掉 "http://" 或 "https://"
            if (urlPart.contains(":")) {
                String[] parts = urlPart.split(":");
                hostname = parts[0];
                actualPort = Integer.parseInt(parts[1]);
            } else {
                hostname = urlPart;
            }
        }

        RestClientBuilder builder = RestClient.builder(
                new HttpHost(hostname, actualPort, scheme)
        );

        // 设置认证
        builder.setHttpClientConfigCallback(httpClientBuilder -> httpClientBuilder
                .setDefaultCredentialsProvider(credentialsProvider));

        // 设置超时时间
        builder.setRequestConfigCallback(requestConfigBuilder -> requestConfigBuilder
                .setConnectTimeout(10000)      // 连接超时 10秒
                .setSocketTimeout(30000));     // 读取超时 30秒

        return new RestHighLevelClient(builder);
    }
}
