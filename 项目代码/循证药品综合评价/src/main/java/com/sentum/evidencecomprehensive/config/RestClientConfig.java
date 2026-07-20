package com.sentum.evidencecomprehensive.config;

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
public class RestClientConfig extends AbstractElasticsearchConfiguration {
    @Value("${spring.elasticsearch.rest.uris}")
    private String uris;
    @Value("${spring.elasticsearch.rest.username}")
    private String username;
    @Value("${spring.elasticsearch.rest.password}")
    private String password;
    @Value("${spring.elasticsearch.rest.read-timeout}")
    private Long connectionTimeout;
    @Value("${spring.elasticsearch.rest.connection-timeout}")
    private Long readTimeout;
    
    @Override
    @Bean  //es 两个端口 9200  9300
    public RestHighLevelClient elasticsearchClient() {
        try {
            String[] uriArray = uris.split(",");
            URI firstUri = new URI(uriArray[0].trim());

            String host = firstUri.getHost();
            int port = firstUri.getPort();

            ClientConfiguration clientConfiguration = ClientConfiguration.builder()
                    .connectedTo(host + ":" + port)  // 只传 host:port，不能带 http://
                    .withBasicAuth(username, password)
                    .withConnectTimeout(Duration.ofMillis(connectionTimeout))
                    .withSocketTimeout(Duration.ofMillis(readTimeout))
                    .build();

            return RestClients.create(clientConfiguration).rest();

        } catch (Exception e) {
            throw new RuntimeException("❌ Failed to create Elasticsearch client: " + e.getMessage(), e);
        }
        
//        final ClientConfiguration clientConfiguration = ClientConfiguration.builder()
//                .connectedTo(host)
//                .withBasicAuth(username, password)
//                .withConnectTimeout(connectionTimeout)
//                .withSocketTimeout(readTimeout)
//                .build();
//        return RestClients.create(clientConfiguration).rest();
    }

    @Bean
    public ElasticsearchRestTemplate elasticsearchRestTemplate(RestHighLevelClient restHighLevelClient) {
        return new ElasticsearchRestTemplate(restHighLevelClient);
    }

}