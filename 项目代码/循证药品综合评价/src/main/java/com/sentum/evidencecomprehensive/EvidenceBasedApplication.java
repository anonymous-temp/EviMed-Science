package com.sentum.evidencecomprehensive;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.netflix.eureka.EnableEurekaClient;
import org.springframework.cloud.openfeign.EnableFeignClients;
import org.springframework.scheduling.annotation.EnableScheduling;

@EnableFeignClients
@EnableEurekaClient
@SpringBootApplication
@EnableScheduling
@MapperScan("com.sentum.evidencecomprehensive.mapper")
public class EvidenceBasedApplication {
    public static void main(String[] args) {
        SpringApplication.run(EvidenceBasedApplication.class, args);
    }
}
