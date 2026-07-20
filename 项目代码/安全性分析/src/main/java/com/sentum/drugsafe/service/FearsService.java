package com.sentum.drugsafe.service;

import cn.hutool.http.HttpResponse;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import javax.servlet.http.HttpServletResponse;
import java.util.List;

@Service
public interface FearsService {
    void getDrug(String filePath, String databaseName, HttpServletResponse response);



    //异步调用
    @Async
    void writeEs(List<String> years);
}
