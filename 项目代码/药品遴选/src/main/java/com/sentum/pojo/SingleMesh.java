package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Set;

/**
 * mesh与药品合并的表
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class SingleMesh {
    /**
     * id
     */
    private String id;
    /**
     * 主题词--设置为唯一id
     */
    private String subjectWords;
    /**
     * 入口词
     */
    private Set<String> entryWord;
    /**
     * mesh词的唯一标识符
     */
    private List<String> ids;
    /**
     * 药品的唯一标识
     */
    private String uniqueIdentification;
}
