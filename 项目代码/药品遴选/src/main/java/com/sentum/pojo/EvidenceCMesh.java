package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;

/**
 * 中文mesh
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class EvidenceCMesh {
    @Id
    private String id;
    /**
     * 主题词
     */
    private String title;
    /**
     * 中文
     */
    private String nameZh;
    /**
     * 英文
     */
    private String nameEn;
    /**
     * 入口词
     */
    private List<String> entryTerms;

    /**
     * 中文同义词
     */
    private List<String> zhEntryTerms;

    /**
     * 英文同义词
     */
    private List<String> enEntryTerms;

    /**
     * 其他类型同义词
     */
    private List<String> otherEntryTerms;
    /**
     * 树形结构编码
     */
    private String treeNumber;
}
