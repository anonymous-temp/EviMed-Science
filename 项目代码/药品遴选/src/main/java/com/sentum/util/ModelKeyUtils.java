package com.sentum.util;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Slf4j
@Component
public class ModelKeyUtils {
    @Autowired
    private RedisTemplate<String, Object> redisTemplate;

    // 存储6个数据的列表
    private static final String DATA_KEY = "dynamic:data";
    // 计数器，用于生成唯一ID
    private static final String COUNTER_KEY = "dynamic:counter";

    private static final Integer All_NUM = 6;

    // 初始化6个数据
    public void initData(List<Object> initialData) {
        // 清空旧数据
        redisTemplate.delete(DATA_KEY);

        // 添加初始数据，确保总数为6个
        for (Object data : initialData) {
            addData(data);
        }

        // 如果初始数据不足6个，补充空数据
        long currentSize = getSize();
        for (long i = currentSize; i < All_NUM; i++) {
            addData(null);
        }
    }

    // 添加新数据（原子操作）
    public void addData(Object data) {
        // 使用原子计数器生成唯一ID
        Long id = redisTemplate.opsForValue().increment(COUNTER_KEY);
        String dataId = "data:" + id;

        // 创建数据对象
        Map<String, Object> dataMap = new HashMap<>();
        dataMap.put("id", dataId);
        dataMap.put("value", data);
        dataMap.put("timestamp", System.currentTimeMillis());

        // 使用LUA脚本原子性地添加新数据并移除最旧的数据
        String script =
                "local currentSize = redis.call('LLEN', KEYS[1]) " +
                        "if currentSize >= "+All_NUM+" then " +
                        "  redis.call('LPOP', KEYS[1]) " +
                        "end " +
                        "redis.call('RPUSH', KEYS[1], ARGV[1]) " +
                        "return 1";

        redisTemplate.execute(connection ->
                connection.scriptingCommands().eval(
                        script.getBytes(),
                        org.springframework.data.redis.connection.ReturnType.INTEGER,
                        1,
                        DATA_KEY.getBytes(),
                        dataMap.toString().getBytes()
                ), true);

    }

    // 获取下一个数据（原子轮询）
    public Map<String, Object> getNextData() {
        // 使用LUA脚本原子性地获取并移动到队列尾部
        String script =
                "local data = redis.call('LPOP', KEYS[1]) " +
                        "if data then " +
                        "  redis.call('RPUSH', KEYS[1], data) " +
                        "  return data " +
                        "else " +
                        "  return nil " +
                        "end";

        byte[] result = redisTemplate.execute(connection ->
                connection.scriptingCommands().eval(
                        script.getBytes(),
                        org.springframework.data.redis.connection.ReturnType.VALUE,
                        1,
                        DATA_KEY.getBytes()
                ), true);

        if (result != null) {
            String dataStr = new String(result);
            // 解析数据字符串为Map（实际项目中可能需要更复杂的解析）
            return parseDataString(dataStr);
        }

        return null;
    }

    // 获取所有数据
    public List<Map<String, Object>> getAllData() {
        List<Object> dataList = redisTemplate.opsForList().range(DATA_KEY, 0, -1);
        List<Map<String, Object>> result = new ArrayList<>();
        if (dataList != null) {
            for (Object data : dataList) {
                if (data != null) {
                    result.add(parseDataString(data.toString()));
                }
            }
        }

        return result;
    }

    // 获取数据列表大小
    public long getSize() {
        Long size = redisTemplate.opsForList().size(DATA_KEY);
        if (size == null) {
            return 0;
        }
        return size;
    }

    // 解析数据字符串（简化实现）
    private Map<String, Object> parseDataString(String dataStr) {
        Map<String, Object> result = new HashMap<>();

        // 实际项目中可能需要更复杂的解析，这里使用简单的字符串处理
        String[] pairs = dataStr.replace("{", "").replace("}", "").split(", ");
        for (String pair : pairs) {
            String[] keyValue = pair.split("=", 2);
            if (keyValue.length == 2) {
                result.put(keyValue[0], keyValue[1]);
            }
        }

        return result;
    }
}
