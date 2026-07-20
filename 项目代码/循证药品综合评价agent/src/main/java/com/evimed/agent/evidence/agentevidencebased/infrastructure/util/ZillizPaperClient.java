package com.evimed.agent.evidence.agentevidencebased.infrastructure.util;

import io.milvus.client.MilvusServiceClient;
import io.milvus.param.ConnectParam;
import lombok.extern.slf4j.Slf4j;

import java.util.concurrent.TimeUnit;

@Slf4j
public class ZillizPaperClient {

    public MilvusServiceClient client() {
        System.setProperty("jsse.enableSNIExtension", "false");
        //System.setProperty("javax.net.ssl.trustStore", "<path-to-cacerts-file>");
        //System.setProperty("javax.net.ssl.trustStorePassword", "<password>");
        String token = System.getenv("ZILLIZ_TOKEN");
        String clusterEndpoint = "https://in01-f141153d490dbb6.ali-cn-beijing.vectordb.zilliz.com.cn:19530";
        ConnectParam connectParam = ConnectParam.newBuilder()
                .withUri(clusterEndpoint)
                .withToken(token)
                .withConnectTimeout(3, TimeUnit.MINUTES)
                .build();
        MilvusServiceClient client;
        try {
            client = new MilvusServiceClient(connectParam);
        } catch (Exception e) {
            log.info("链接失败，开始重试");
            //e.printStackTrace();
            client = new MilvusServiceClient(connectParam);
        }
        log.info("Connected to Zilliz Cloud!");
        return client;
    }
}
