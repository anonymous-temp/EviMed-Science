package com.sentum.util;

import com.alibaba.fastjson.JSONObject;
import com.github.rholder.retry.Retryer;
import com.github.rholder.retry.RetryerBuilder;
import com.github.rholder.retry.StopStrategies;
import com.github.rholder.retry.WaitStrategies;
import com.sentum.constants.CommonConstants;
import org.apache.poi.ooxml.util.PackageHelper;

import java.util.concurrent.TimeUnit;

/**
 * @Description: guava 重试机制
 */
public class GuavaRetryer<T> {
    public static Retryer createRetryer() {
        // retry 的重试机制 

        return RetryerBuilder.<JSONObject>newBuilder()
                .retryIfException()
//                .retryIfResult(result -> Objects.equals(result, CommonConstants.BOOLEAN_FALSE))
                .withWaitStrategy(WaitStrategies.fixedWait(CommonConstants.THOUSAND, TimeUnit.MICROSECONDS))
                .withStopStrategy(StopStrategies.stopAfterAttempt(CommonConstants.TRANSMISSION_RETRY_ATTEMPT))
                .build();
    }

    public static Retryer createRetryerAttemptSix() {
        // retry 的重试机制 

        return RetryerBuilder.<JSONObject>newBuilder() 
                .retryIfException()
//                .retryIfResult(result -> Objects.equals(result, CommonConstants.BOOLEAN_FALSE))
                .withWaitStrategy(WaitStrategies.fixedWait(CommonConstants.THOUSAND, TimeUnit.MICROSECONDS))
                .withStopStrategy(StopStrategies.stopAfterAttempt(CommonConstants.TRANSMISSION_RETRY_ATTEMPT_SIX))
                .build();
    }
}
