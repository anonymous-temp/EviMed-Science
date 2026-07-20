package com.sentum.evidencecomprehensive;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.netflix.eureka.EnableEurekaClient;
import org.springframework.cloud.openfeign.EnableFeignClients;
import org.springframework.retry.annotation.EnableRetry;
import org.springframework.scheduling.annotation.EnableScheduling;

@EnableFeignClients
@EnableEurekaClient
@SpringBootApplication
@EnableScheduling
@EnableRetry
public class EvidenceChaoApplication {

    public static void main(String[] args) {
        SpringApplication.run(EvidenceChaoApplication.class, args);
    }

}
