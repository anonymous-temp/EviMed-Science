package com.sentum.drugsafe.config;

import org.apache.http.client.config.RequestConfig;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.elasticsearch.RestClientBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

@Configuration
public class ElasticsearchTimeoutConfig {

    @Bean
    public RestClientBuilderCustomizer restClientBuilderCustomizer(
            @Value("${spring.elasticsearch.rest.connection-timeout:10s}") Duration connectionTimeout,
            @Value("${spring.elasticsearch.rest.read-timeout:10s}") Duration readTimeout) {
        return builder -> builder.setRequestConfigCallback(requestConfigBuilder -> customizeTimeouts(requestConfigBuilder, connectionTimeout, readTimeout));
    }

    private RequestConfig.Builder customizeTimeouts(RequestConfig.Builder requestConfigBuilder,
                                                    Duration connectionTimeout,
                                                    Duration readTimeout) {
        int connectTimeoutMillis = Math.toIntExact(connectionTimeout.toMillis());
        int socketTimeoutMillis = Math.toIntExact(readTimeout.toMillis());
        return requestConfigBuilder
                .setConnectTimeout(connectTimeoutMillis)
                .setConnectionRequestTimeout(connectTimeoutMillis)
                .setSocketTimeout(socketTimeoutMillis);
    }
}
