package com.sentum.evidencecomprehensive.config;

import lombok.AllArgsConstructor;

import java.util.concurrent.ThreadFactory;

/**
 * @Description:
 */
@AllArgsConstructor
public class MyThreadFactory implements ThreadFactory {
    private static final MyUncaughtExceptionHandler MY_UNCAUGHT_EXCEPTION_HANDLER = new MyUncaughtExceptionHandler();
    
    private ThreadFactory originalFactory;
    
    @Override
    public Thread newThread(Runnable r) {
        Thread thread = originalFactory.newThread(r);
        thread.setUncaughtExceptionHandler(MY_UNCAUGHT_EXCEPTION_HANDLER);
        return thread;
    }
}
